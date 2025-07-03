//! This example data loader parses newline-separated lines of JSON of 2 forms:
//!
//! {"type":"temperature","time":0,"ambient":21,"cpu0":70,"cpu1":65,"cpu2":68,"cpu3":72}
//! {"type":"accelerometer","time":0,"x":0,"y":0.00175,"z":0.17936678638491532}
//!
//! The loader stores the records in memory and publishes /accelerometer and /temperature topics.

use anyhow::anyhow;
use foxglove::Encode;
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader},
    rc::Rc,
};

foxglove_data_loader::export!(NDJsonLoader);
use foxglove_data_loader::{
    BackfillArgs, DataLoader, DataLoaderArgs, Initialization, Message, MessageIterator,
    MessageIteratorArgs, console, reader,
};

#[derive(Default)]
struct NDJsonLoader {
    path: String,
    rows: Rc<Vec<Row>>,
    init: Rc<Initialization>, // save the initialization so we can query channel ids by topic
}

impl DataLoader for NDJsonLoader {
    type MessageIterator = NDJsonIterator;
    type Error = anyhow::Error;

    fn new(args: DataLoaderArgs) -> Self {
        let path = args
            .paths
            .first()
            .unwrap_or_else(|| panic!["didn't receive a file path as input"])
            .clone();
        Self {
            path,
            ..Self::default()
        }
    }

    fn initialize(&mut self) -> Result<Initialization, Self::Error> {
        let lines = BufReader::new(reader::open(&self.path)).lines();
        let mut rows: Vec<Row> = lines
            .map(|rline| {
                rline
                    .and_then(|line| serde_json::from_str(&line).map_err(|err| err.into()))
                    .map_err(|err| err.into())
            })
            .collect::<Result<Vec<Row>, Self::Error>>()?;
        rows.sort_by(|a, b| {
            f64::partial_cmp(&a.get_time(), &b.get_time()).expect("time comparison failed")
        });
        let start_seconds = rows
            .first()
            .ok_or(anyhow!["failed to read first row"])?
            .get_time();
        let end_seconds = rows
            .last()
            .ok_or(anyhow!["failed to read last row"])?
            .get_time();
        let temperature_count = rows
            .iter()
            .filter(|row| matches![row, Row::Temperature(_)])
            .count();
        let accelerometer_count = rows
            .iter()
            .filter(|row| matches![row, Row::Accelerometer(_)])
            .count();

        self.rows = Rc::new(rows);
        console::log(&format![
            "Temperature[{temperature_count}], Accelerometer[{accelerometer_count}]"
        ]);

        let mut init = Initialization::builder()
            .start_time(seconds_to_nanos(start_seconds))
            .end_time(seconds_to_nanos(end_seconds));

        let vec3_schema = init.add_encode::<Accelerometer>()?;
        init.add_channel("/accelerometer")
            .schema(&vec3_schema)
            .message_count(accelerometer_count as u64);

        let temp_schema = init.add_encode::<Temperature>()?;
        init.add_channel("/temperature")
            .schema(&temp_schema)
            .message_count(temperature_count as u64);

        self.init = Rc::new(init.build());
        Ok((*self.init).clone())
    }

    fn create_iter(
        &mut self,
        args: MessageIteratorArgs,
    ) -> Result<Self::MessageIterator, Self::Error> {
        Ok(NDJsonIterator::open(
            self.rows.clone(),
            self.init.clone(),
            &args,
        ))
    }

    fn get_backfill(&mut self, args: BackfillArgs) -> Result<Vec<Message>, Self::Error> {
        let accel_ch_id = self.init.get_channel("/accelerometer").unwrap().id;
        let temp_ch_id = self.init.get_channel("/temperature").unwrap().id;
        let want_accelerometer = args.channels.contains(&accel_ch_id);
        let want_temperature = args.channels.contains(&temp_ch_id);

        let mut backfill: Vec<Message> = vec![];
        if want_accelerometer {
            let option_backfill_accelerometer = self.rows
                .iter()
                .take_while(|row| {
                    matches![row, Row::Accelerometer(accel) if seconds_to_nanos(accel.time) <= args.time]
                })
                .last();
            if let Some(Row::Accelerometer(accel)) = option_backfill_accelerometer {
                backfill.push(accel.to_message(accel_ch_id));
            }
        }
        if want_temperature {
            let option_backfill_temperature = self.rows
                .iter()
                .take_while(|row| {
                    matches![row, Row::Temperature(temperature) if seconds_to_nanos(temperature.time) <= args.time]
                })
                .last();
            if let Some(Row::Temperature(temperature)) = option_backfill_temperature {
                backfill.push(temperature.to_message(accel_ch_id));
            }
        }
        Ok(backfill)
    }
}

struct NDJsonIterator {
    rows: Rc<Vec<Row>>,
    index: usize,
    start: u64,
    end: u64,
    channels: BTreeSet<u16>,
    init: Rc<Initialization>,
}

impl NDJsonIterator {
    fn open(rows: Rc<Vec<Row>>, init: Rc<Initialization>, args: &MessageIteratorArgs) -> Self {
        Self {
            rows: rows.clone(),
            init,
            index: 0,
            start: args.start_time.unwrap_or(0),
            end: args.end_time.unwrap_or(u64::MAX),
            channels: args.channels.iter().copied().collect(),
        }
    }
}

impl MessageIterator for NDJsonIterator {
    type Error = anyhow::Error;

    fn next(&mut self) -> Option<Result<Message, Self::Error>> {
        let acc_ch_id = self.init.get_channel("/accelerometer").unwrap().id;
        let temp_ch_id = self.init.get_channel("/temperature").unwrap().id;
        loop {
            let row = self.rows.get(self.index);
            self.index += 1;
            if let Some(time) = row.map(|r| seconds_to_nanos(r.get_time())) {
                if time < self.start {
                    continue;
                }
                if time > self.end {
                    return None;
                }
            };
            match row {
                None => return None,
                Some(Row::Accelerometer(accel)) => {
                    if self.channels.contains(&acc_ch_id) {
                        return Some(Ok(accel.to_message(acc_ch_id)));
                    }
                }
                Some(Row::Temperature(temperature)) => {
                    if self.channels.contains(&temp_ch_id) {
                        return Some(Ok(temperature.to_message(temp_ch_id)));
                    }
                }
            };
        }
    }
}

// floating point time in seconds to u64 nanoseconds
fn seconds_to_nanos(time_seconds: f64) -> u64 {
    (time_seconds * 1.0e9) as u64
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type")]
enum Row {
    #[serde(rename = "accelerometer")]
    Accelerometer(Accelerometer),
    #[serde(rename = "temperature")]
    Temperature(Temperature),
}

impl Row {
    fn get_time(&self) -> f64 {
        match self {
            Row::Accelerometer(accel) => accel.time,
            Row::Temperature(temperature) => temperature.time,
        }
    }
}

#[derive(Debug, Clone, foxglove::Encode, serde::Deserialize)]
struct Accelerometer {
    time: f64, // in seconds
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone, foxglove::Encode, serde::Deserialize)]
struct Temperature {
    time: f64, // in seconds
    ambient: f64,
    cpu0: f64,
    cpu1: f64,
    cpu2: f64,
    cpu3: f64,
}

impl Accelerometer {
    fn to_message(&self, channel_id: u16) -> Message {
        let time_nanos = seconds_to_nanos(self.time);
        let mut data = Vec::with_capacity(self.encoded_len().unwrap_or(0));
        self.encode(&mut data)
            .expect("failed to encode Accelerometer");
        Message {
            channel_id,
            log_time: time_nanos,
            publish_time: time_nanos,
            data,
        }
    }
}

impl Temperature {
    fn to_message(&self, channel_id: u16) -> Message {
        let time_nanos = seconds_to_nanos(self.time);
        let mut data = Vec::with_capacity(self.encoded_len().unwrap_or(0));
        self.encode(&mut data)
            .expect("failed to encode Temperature");
        Message {
            channel_id,
            log_time: time_nanos,
            publish_time: time_nanos,
            data,
        }
    }
}
