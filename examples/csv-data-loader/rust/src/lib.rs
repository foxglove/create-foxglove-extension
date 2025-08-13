use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

use anyhow::bail;

use csv::StringRecord;
use foxglove_data_loader::{
    DataLoader, DataLoaderArgs, Initialization, Message, MessageIterator, MessageIteratorArgs,
    reader::{self},
};
use serde_json::json;

#[derive(Default)]
struct CsvDataLoader {
    paths: Vec<String>,
    indexes: BTreeMap<u64, u64>,
    log_time_index: usize,
    keys: Vec<String>,
}

impl DataLoader for CsvDataLoader {
    type MessageIterator = CsvMessageIterator;
    type Error = anyhow::Error;

    fn new(args: DataLoaderArgs) -> Self {
        let DataLoaderArgs { paths } = args;
        Self {
            paths,
            ..Default::default()
        }
    }

    fn initialize(&mut self) -> Result<Initialization, Self::Error> {
        let Some(path) = self.paths.first() else {
            bail!("no paths provided to data loader");
        };

        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(reader::open(path));

        let headers = reader.headers()?;

        self.keys = headers.iter().map(String::from).collect();

        let Some(log_time_index) = self.keys.iter().position(|k| k == "timestamp_nanos") else {
            bail!("expected csv to contain column called timestamp_nanos")
        };

        self.log_time_index = log_time_index;

        let mut record = StringRecord::new();
        let mut position = reader.position().byte();

        while reader.read_record(&mut record)? {
            let timestamp_nanos: u64 = record[log_time_index].parse()?;
            self.indexes.insert(timestamp_nanos, position);
            position = reader.position().byte();
        }

        let mut builder = Initialization::builder()
            .start_time(
                self.indexes
                    .first_key_value()
                    .map(|(timestamp, _)| *timestamp)
                    .unwrap_or(0),
            )
            .end_time(
                self.indexes
                    .last_key_value()
                    .map(|(timestamp, _)| *timestamp)
                    .unwrap_or(0),
            );

        for (i, key) in self.keys.iter().enumerate() {
            if key == "timestamp_nanos" {
                continue;
            }

            builder
                .add_channel_with_id(i as _, &format!("/{key}"))
                .expect("channel is free")
                .message_encoding("json")
                .message_count(self.indexes.len() as _);
        }

        Ok(builder.build())
    }

    fn create_iter(
        &mut self,
        args: MessageIteratorArgs,
    ) -> Result<Self::MessageIterator, Self::Error> {
        let requested_channel_id = args.channels.into_iter().collect();

        match self.indexes.range(args.start_time.unwrap_or(0)..).next() {
            Some((_, byte_offset)) => {
                let reader = reader::open(&self.paths[0]);
                reader.seek(*byte_offset);

                Ok(CsvMessageIterator {
                    messages_to_flush: Default::default(),
                    log_time_index: self.log_time_index,
                    requested_channel_id,
                    reader: csv::Reader::from_reader(Box::new(reader)),
                })
            }
            None => Ok(CsvMessageIterator {
                messages_to_flush: Default::default(),
                log_time_index: self.log_time_index,
                requested_channel_id: Default::default(),
                reader: csv::Reader::from_reader(Box::new(Cursor::new([]))),
            }),
        }
    }
}

struct CsvMessageIterator {
    messages_to_flush: Vec<Message>,
    log_time_index: usize,
    requested_channel_id: BTreeSet<u16>,
    reader: csv::Reader<Box<dyn Read>>,
}

fn to_serde_value(value: &str) -> serde_json::Value {
    if let Ok(v) = value.parse::<f64>() {
        return json!(v);
    }

    if let Ok(v) = value.parse::<bool>() {
        return json!(v);
    }

    json!(value)
}

impl MessageIterator for CsvMessageIterator {
    type Error = anyhow::Error;

    fn next(&mut self) -> Option<Result<Message, Self::Error>> {
        loop {
            if let Some(message) = self.messages_to_flush.pop() {
                return Some(Ok(message));
            }

            let mut record = StringRecord::new();

            match self.reader.read_record(&mut record) {
                Err(e) => {
                    return Some(Err(e.into()));
                }
                Ok(false) => {
                    return None;
                }
                // fall through
                Ok(true) => {}
            }

            let timestamp = match record[self.log_time_index].parse::<u64>() {
                Ok(t) => t,
                Err(e) => {
                    return Some(Err(e.into()));
                }
            };

            for (index, value) in record.iter().enumerate() {
                // Don't emit the log time index as a
                if index == self.log_time_index {
                    continue;
                }

                let channel_id = index as u16;

                if !self.requested_channel_id.contains(&channel_id) {
                    continue;
                }

                let data = match serde_json::to_vec(&json!({ "value": to_serde_value(value) })) {
                    Ok(d) => d,
                    Err(e) => {
                        return Some(Err(e.into()));
                    }
                };

                self.messages_to_flush.push(Message {
                    channel_id,
                    log_time: timestamp,
                    publish_time: timestamp,
                    data,
                });
            }
        }
    }
}

foxglove_data_loader::export!(CsvDataLoader);
