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
    console, reader, BackfillArgs, Channel, DataLoader, DataLoaderArgs, Initialization, Message,
    MessageIterator, MessageIteratorArgs, Schema, TimeRange,
};

const ACCELEROMETER_CHANNEL_ID: u16 = 1;
const ACCELEROMETER_SCHEMA_ID: u16 = 1;
const TEMPERATURE_CHANNEL_ID: u16 = 2;
const TEMPERATURE_SCHEMA_ID: u16 = 2;

#[derive(Default)]
struct NDJsonLoader {
    path: String,
    rows: Rc<RefCell<Vec<Row>>>,
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

        let accelerometer_channel = Channel {
            id: ACCELEROMETER_CHANNEL_ID,
            schema_id: Some(ACCELEROMETER_SCHEMA_ID),
            topic_name: "/accelerometer".to_string(),
            message_encoding: Vector3::get_message_encoding(),
            message_count: Some(accelerometer_count as u64),
        };
        let accelerometer_schema = Schema::from_id_sdk(
            ACCELEROMETER_SCHEMA_ID,
            Vector3::get_schema().ok_or(anyhow!["failed to get Vector3 schema"])?,
        );

        let temperature_channel = Channel {
            id: TEMPERATURE_CHANNEL_ID,
            schema_id: Some(TEMPERATURE_SCHEMA_ID),
            topic_name: "/temperature".to_string(),
            message_encoding: Temperature::get_message_encoding(),
            message_count: Some(temperature_count as u64),
        };
        let temperature_schema = Schema::from_id_sdk(
            TEMPERATURE_SCHEMA_ID,
            Temperature::get_schema().ok_or(anyhow!["failed to get Temperature schema"])?
        );

        let time_range = TimeRange {
            start_time: seconds_to_nanos(start_seconds),
            end_time: seconds_to_nanos(end_seconds),
        };

        Ok(Initialization {
            channels: vec![accelerometer_channel, temperature_channel],
            schemas: vec![accelerometer_schema, temperature_schema],
            time_range,
            problems: vec![],
        })
    }

    fn create_iter(&self, args: MessageIteratorArgs) -> Result<Self::MessageIterator, Self::Error> {
        Ok(NDJsonIterator::open(self.rows.clone(), &args))
    }

    fn get_backfill(&self, args: BackfillArgs) -> Result<Vec<Message>, Self::Error> {
        let want_accelerometer = args.channels.contains(&ACCELEROMETER_CHANNEL_ID);
        let want_temperature = args.channels.contains(&TEMPERATURE_CHANNEL_ID);

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
                backfill.push(accel.into());
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
                backfill.push(temperature.into());
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
}

impl NDJsonIterator {
    fn open(rows: Rc<RefCell<Vec<Row>>>, args: &MessageIteratorArgs) -> Self {
        Self {
            rows: rows.clone(),
            index: 0.into(),
            start: args.start_time.unwrap_or(0),
            end: args.end_time.unwrap_or(u64::MAX),
            channels: args.channels.iter().copied().collect(),
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
                    if self.channels.contains(&ACCELEROMETER_CHANNEL_ID) {
                        return Some(Ok(accel.into()));
                    }
                }
                Some(Row::Temperature(temperature)) => {
                    if self.channels.contains(&TEMPERATURE_CHANNEL_ID) {
                        return Some(Ok(temperature.into()));
                    }
                }
            };
        }
    }
}

// floating point time in seconds to u64 nanoseconds
fn seconds_to_nanos(time: f64) -> u64 {
    (time * 1.0e9) as u64
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
    time: f64,
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone, foxglove::Encode, serde::Serialize, serde::Deserialize)]
struct Temperature {
    time: f64,
    ambient: f64,
    cpu0: f64,
    cpu1: f64,
    cpu2: f64,
    cpu3: f64,
}

impl From<&Accelerometer> for Message {
    fn from(accel: &Accelerometer) -> Message {
        let time_nanos = seconds_to_nanos(accel.time);
        Message {
            channel_id: ACCELEROMETER_CHANNEL_ID,
            log_time: time_nanos,
            publish_time: time_nanos,
            data: Vector3 {
                x: accel.x,
                y: accel.y,
                z: accel.z,
            }.encode_to_vec(),
        }
    }
}

impl From<&Temperature> for Message {
    fn from(temperature: &Temperature) -> Message {
        let time = seconds_to_nanos(temperature.time);
        let mut data = Vec::with_capacity(temperature.encoded_len().unwrap_or(0));
        temperature.encode(&mut data).expect("failed to encode Temperature");
        Message {
            channel_id: TEMPERATURE_CHANNEL_ID,
            log_time: time,
            publish_time: time,
            data,
        }
    }
}
