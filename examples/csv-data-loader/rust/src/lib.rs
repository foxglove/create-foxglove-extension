use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

use foxglove_data_loader::{
    DataLoader, DataLoaderArgs, Initialization, Message, MessageIterator, MessageIteratorArgs,
    reader::{self},
};

use anyhow::bail;
use csv::StringRecord;
use serde_json::json;

#[derive(Default)]
struct CsvDataLoader {
    path: String,
    /// Index of timestamp to byte offset
    indexes: BTreeMap<u64, u64>,
    /// The index of the field containing timestamp
    log_time_index: usize,
    /// The keys from the first row of the CSV
    keys: Vec<String>,
}

impl DataLoader for CsvDataLoader {
    type MessageIterator = CsvMessageIterator;
    type Error = anyhow::Error;

    fn new(args: DataLoaderArgs) -> Self {
        let DataLoaderArgs { mut paths } = args;
        assert_eq!(
            paths.len(),
            1,
            "data loader is configured to only get one file"
        );
        Self {
            path: paths.remove(0),
            ..Default::default()
        }
    }

    fn initialize(&mut self) -> Result<Initialization, Self::Error> {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .trim(csv::Trim::All)
            .from_reader(reader::open(&self.path));

        // Read the headers of the CSV and store them on the loader.
        // We will turn each column into a topic so the CSV needs to have a header.
        let headers = reader.headers()?;
        self.keys = headers.iter().map(String::from).collect();

        // Read through the keys and try to find a field called "timestamp_nanos". If this doesn't
        // exit then we can't read the file as we have no way of knowing the log time.
        let Some(log_time_index) = self.keys.iter().position(|k| k == "timestamp_nanos") else {
            bail!("expected csv to contain column called timestamp_nanos")
        };

        // Store the column index of the timestamp to be used for the log time.
        self.log_time_index = log_time_index;

        let mut record = StringRecord::new();
        let mut position = reader.position().byte();

        // Read the entire file to build up an index of timestamps to byte position.
        // Later on we'll use this index to make sure we can immediately start reading from the
        // correct place. This will take a little bit of time when the file loads for the first
        // time, but it will mean playback is snappy later on.
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
            // Don't add a channel for the column used for log time
            if i == self.log_time_index {
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
                let reader = reader::open(&self.path);
                reader.seek(*byte_offset);

                Ok(CsvMessageIterator {
                    row_to_flush: Default::default(),
                    log_time_index: self.log_time_index,
                    requested_channel_id,
                    reader: csv::ReaderBuilder::new()
                        .has_headers(false)
                        .trim(csv::Trim::All)
                        .from_reader(Box::new(reader)),
                })
            }
            // If there is no byte offset (we've gone past the last timestamp), return empty iter
            None => Ok(CsvMessageIterator {
                log_time_index: self.log_time_index,
                row_to_flush: Default::default(),
                requested_channel_id: Default::default(),
                reader: csv::Reader::from_reader(Box::new(Cursor::new([]))),
            }),
        }
    }
}

struct CsvMessageIterator {
    row_to_flush: Vec<Message>,
    log_time_index: usize,
    requested_channel_id: BTreeSet<u16>,
    reader: csv::Reader<Box<dyn Read>>,
}

/// Try and coerce the string into a JSON value.
///
/// Try to convert to a f64, then bool, else finally return a string.
fn to_json_value(value: &str) -> serde_json::Value {
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
            // We emit each column of a row as its own message.
            if let Some(message) = self.row_to_flush.pop() {
                return Some(Ok(message));
            }

            let mut columns = StringRecord::new();

            match self.reader.read_record(&mut columns) {
                Err(e) => {
                    return Some(Err(e.into()));
                }
                Ok(false) => {
                    return None;
                }
                // fall through
                Ok(true) => {}
            }

            // Get the log time for the row. This will need to be on every message.
            let timestamp = match columns[self.log_time_index].parse::<u64>() {
                Ok(t) => t,
                Err(e) => {
                    return Some(Err(e.into()));
                }
            };

            for (index, cell) in columns.iter().enumerate() {
                // Don't emit the timestamp column as a message
                if index == self.log_time_index {
                    continue;
                }

                let channel_id = index as u16;

                // If this column wasn't requested, skip it
                if !self.requested_channel_id.contains(&channel_id) {
                    continue;
                }

                let data = serde_json::to_vec(&json!({ "value": to_json_value(cell) }))
                    .expect("json will not fail to serialize");

                // Add this message to the row and continue onto the next column
                self.row_to_flush.push(Message {
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
