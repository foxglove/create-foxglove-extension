//! This example data loader parses newline-separated lines of JSON of 2 forms:
//!
//! {"type":"temperature","time":0,"ambient":21,"cpu0":70,"cpu1":65,"cpu2":68,"cpu3":72}
//! {"type":"accelerometer","time":0,"x":0,"y":0.00175,"z":0.17936678638491532}
//!
//! The loader stores the records in memory and publishes /accelerometer and /temperature topics.

use anyhow::anyhow;
use foxglove::schemas::Vector3;
use foxglove::Encode;
use prost::Message as ProstMessage;
use std::{
    cell::RefCell,
    collections::BTreeSet,
    io::{BufRead, BufReader},
    rc::Rc,
};

foxglove_data_loader::export!(NDJsonLoader);
use foxglove_data_loader::{
    console, reader, BackfillArgs, DataLoader, DataLoaderArgs, Initialization,
    Message, MessageIterator, MessageIteratorArgs,
};

#[derive(Default)]
struct NDJsonLoader {
    path: String,
    rows: Rc<RefCell<Vec<Row>>>,
    accelerometer_channel_id: Rc<RefCell<u16>>,
    temperature_channel_id: Rc<RefCell<u16>>,
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

    fn initialize(&self) -> Result<Initialization, Self::Error> {
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
        let start_seconds = rows.first().ok_or(anyhow!["failed to read first row"])?.get_time();
        let end_seconds = rows.last().ok_or(anyhow!["failed to read last row"])?.get_time();
        let temperature_count = rows.iter().filter(|row| matches![row, Row::Temperature(_)]).count();
        let accelerometer_count = rows.iter().filter(|row| matches![row, Row::Accelerometer(_)]).count();

        self.rows.replace(rows);
        console::log(&format!["Temperature[{temperature_count}], Accelerometer[{accelerometer_count}]"]);

        let mut init = Initialization::builder()
            .start_time(seconds_to_nanos(start_seconds))
            .end_time(seconds_to_nanos(end_seconds));

        let mut accelerometer_schema = init.add_encode::<Vector3>()?;
        let accelerometer_channel = accelerometer_schema
            .add_channel("/accelerometer")
            .message_count(accelerometer_count as u64);
        self.accelerometer_channel_id.replace(accelerometer_channel.id);

        let mut temperature_schema = init.add_encode::<Temperature>()?;
        let temperature_channel = temperature_schema
            .add_channel("/temperature")
            .message_count(temperature_count as u64);
        self.temperature_channel_id.replace(temperature_channel.id);

        Ok(init.build())
    }

    fn create_iter(&self, args: MessageIteratorArgs) -> Result<Self::MessageIterator, Self::Error> {
        Ok(NDJsonIterator::open(
            self.rows.clone(),
            *self.accelerometer_channel_id.borrow(),
            *self.temperature_channel_id.borrow(),
            &args,
        ))
    }

    fn get_backfill(&self, args: BackfillArgs) -> Result<Vec<Message>, Self::Error> {
        let accelerometer_channel_id = *self.accelerometer_channel_id.borrow();
        let temperature_channel_id = *self.temperature_channel_id.borrow();
        let want_accelerometer = args.channels.contains(&accelerometer_channel_id);
        let want_temperature = args.channels.contains(&temperature_channel_id);

        let rows = self.rows.borrow();
        let mut backfill: Vec<Message> = vec![];
        if want_accelerometer {
            let option_backfill_accelerometer = rows
                .iter()
                .take_while(|row| {
                    matches![row, Row::Accelerometer(accel) if seconds_to_nanos(accel.time) < args.time]
                })
                .last();
            if let Some(Row::Accelerometer(accel)) = option_backfill_accelerometer {
                backfill.push(accel.to_message(accelerometer_channel_id));
            }
        }
        if want_temperature {
            let option_backfill_temperature = rows
                .iter()
                .take_while(|row| {
                    matches![row, Row::Temperature(temperature) if seconds_to_nanos(temperature.time) < args.time]
                })
                .last();
            if let Some(Row::Temperature(temperature)) = option_backfill_temperature {
                backfill.push(temperature.to_message(accelerometer_channel_id));
            }
        }
        Ok(backfill)
    }
}

struct NDJsonIterator {
    rows: Rc<RefCell<Vec<Row>>>,
    index: RefCell<usize>,
    start: u64,
    end: u64,
    channels: BTreeSet<u16>,
    accelerometer_channel_id: u16,
    temperature_channel_id: u16,
}

impl NDJsonIterator {
    fn open(
        rows: Rc<RefCell<Vec<Row>>>,
        accelerometer_channel_id: u16,
        temperature_channel_id: u16,
        args: &MessageIteratorArgs
    ) -> Self {
        Self {
            rows: rows.clone(),
            index: 0.into(),
            start: args.start_time.unwrap_or(0),
            end: args.end_time.unwrap_or(u64::MAX),
            channels: args.channels.iter().copied().collect(),
            accelerometer_channel_id,
            temperature_channel_id,
        }
    }
}

impl MessageIterator for NDJsonIterator {
    type Error = anyhow::Error;

    fn next(&self) -> Option<Result<Message, Self::Error>> {
        loop {
            let index = *self.index.borrow();
            self.index.replace(index + 1);
            let rows = self.rows.borrow();
            let row = rows.get(index);
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
                    if self.channels.contains(&self.accelerometer_channel_id) {
                        return Some(Ok(accel.to_message(self.accelerometer_channel_id)));
                    }
                }
                Some(Row::Temperature(temperature)) => {
                    if self.channels.contains(&self.temperature_channel_id) {
                        return Some(Ok(temperature.to_message(self.temperature_channel_id)));
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Accelerometer {
    time: f64, // in seconds
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone, foxglove::Encode, serde::Serialize, serde::Deserialize)]
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
        Message {
            channel_id,
            log_time: time_nanos,
            publish_time: time_nanos,
            data: Vector3 {
                x: self.x,
                y: self.y,
                z: self.z,
            }.encode_to_vec(),
        }
    }
}

impl Temperature {
    fn to_message(&self, channel_id: u16) -> Message {
        let time_nanos = seconds_to_nanos(self.time);
        let mut data = Vec::with_capacity(self.encoded_len().unwrap_or(0));
        self.encode(&mut data).expect("failed to encode Temperature");
        Message {
            channel_id,
            log_time: time_nanos,
            publish_time: time_nanos,
            data,
        }
    }
}
