use std::{
    cell::RefCell,
    collections::BTreeSet,
    io::{BufReader, BufRead, Read},
    rc::Rc,
};
use foxglove::schemas::{
    SpherePrimitive,
    SceneUpdate,
    SceneEntity,
    Vector3,
    Color,
    Timestamp,
    Quaternion,
    Pose,
};
use prost::Message as ProstMessage;
use anyhow::anyhow;

foxglove_data_loader::export!(NDJsonLoader);
use foxglove_data_loader::{
    reader, DataLoader, InitializeResult, BackfillArgs, TimeRange,
    Message, MessageIterator, MessageIteratorArgs, Channel, ChannelBuilder,
};

const SPHERE_CHANNEL_ID: u16 = 1;
const TEMPERATURE_CHANNEL_ID: u16 = 2;

#[derive(Default)]
struct NDJsonLoader {
    path: String,
    sphere_count: u64,
    temperature_count: u64,
    rows: Rc<RefCell<Vec<Row>>>,
}

impl DataLoader for NDJsonLoader {
    type MessageIterator = NDJsonIterator;
    type Error = anyhow::Error;

    fn from_paths(inputs: Vec<String>) -> Result<Self, Self::Error> {
        let path = inputs.get(0).ok_or(anyhow!["didn't receive a file path as input"])?;
        let mut loader = Self::default();
        loader.path = path.clone();
        Ok(loader)
    }

    fn initialize(&self) -> InitializeResult {
        let lines = BufReader::new(reader::open(&self.path)).lines();
        let mut rows: Vec<Row> = lines
            .map(|r| r
                .and_then(|line| serde_json::from_str(&line).map_err(|err| err.into()))
                .map_err(|err| err.into())
            )
            .collect::<Result<Vec<Row>, Self::Error>>()
            .expect("parsing json failed");
        rows.sort_by(|a, b| {
            let time_a = a.get_time().unwrap_or(f64::MIN);
            let time_b = b.get_time().unwrap_or(f64::MIN);
            f64::partial_cmp(&time_a, &time_b).expect("time comparison failed")
        });

        let Some(Row::Info(info)) = (&rows).into_iter()
            .find(|row| matches![row, Row::Info(_)])
            .cloned()
            else { panic!["did not find type=\"info\" row"] };
        self.rows.replace(rows);

        let sphere_channel = ChannelBuilder::default()
            .id(SPHERE_CHANNEL_ID)
            .topic("/scene")
            .encode::<SceneUpdate>()
            .message_count(Some(info.sphere_count))
            .build();

        let temperature_channel = ChannelBuilder::default()
            .id(TEMPERATURE_CHANNEL_ID)
            .topic("/temperature")
            .message_count(Some(info.temperature_count))
            .message_encoding("json")
            .schema_name("temperature")
            .schema_encoding("jsonschema")
            .schema_data(TEMPERATURE_SCHEMA.to_vec())
            .build();

        let time_range = TimeRange {
            start_nanos: seconds_to_nanos(info.start),
            end_nanos: seconds_to_nanos(info.end),
        };

        InitializeResult {
            channels: vec![sphere_channel, temperature_channel],
            time_range,
            problems: vec![],
        }
    }

    fn create_iter(&self, args: MessageIteratorArgs) -> Result<Self::MessageIterator, Self::Error> {
        Ok(NDJsonIterator::open(self.rows.clone(), &args))
    }

    fn get_backfill(&self, args: BackfillArgs) -> Result<Vec<Message>, Self::Error> {
        let want_sphere = args.channels.contains(&SPHERE_CHANNEL_ID);
        let want_temperature = args.channels.contains(&TEMPERATURE_CHANNEL_ID);

        let rows = self.rows.borrow();
        let mut backfill: Vec<Message> = vec![];
        if want_sphere {
            let option_backfill_sphere = rows.iter().take_while(|row| {
                match row {
                    Row::Sphere(sphere) => seconds_to_nanos(sphere.time) < args.time_nanos,
                    _ => false,
                }
            }).last();
            if let Some(Row::Sphere(sphere)) = option_backfill_sphere {
                backfill.push(sphere.into());
            }
        }
        if want_temperature {
            let option_backfill_temperature = rows.iter().take_while(|row| {
                match row {
                    Row::Temperature(temperature) => seconds_to_nanos(temperature.time) < args.time_nanos,
                    _ => false,
                }
            }).last();
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
    time: RefCell<u64>,
    start: u64,
    end: u64,
    channels: BTreeSet<u16>,
}

impl NDJsonIterator {
    fn open(rows: Rc<RefCell<Vec<Row>>>, args: &MessageIteratorArgs) -> Self {
        Self {
            rows: rows.clone(),
            index: 0.into(),
            start: args.start_nanos.unwrap_or(0),
            end: args.end_nanos.unwrap_or(u64::MAX),
            time: RefCell::new(args.start_nanos.unwrap_or(0)),
            channels: args.channels.iter().copied().collect(),
        }
    }
}

impl MessageIterator for NDJsonIterator {
    type Error = anyhow::Error;

    fn next(&self) -> Option<Result<Message, Self::Error>> {
        loop {
            let index = *self.index.borrow();
            self.index.replace(index+1);
            match self.rows.borrow().get(index) {
                None => { return None },
                Some(Row::Info(_)) => {},
                Some(Row::Sphere(sphere)) => {
                    if self.channels.contains(&SPHERE_CHANNEL_ID) {
                        return Some(Ok(sphere.into()));
                    }
                },
                Some(Row::Temperature(temperature)) => {
                    if self.channels.contains(&TEMPERATURE_CHANNEL_ID) {
                        return Some(Ok(temperature.into()));
                    }
                },
            };
        }
    }
}

// floating point time in seconds to u64 nanoseconds
fn seconds_to_nanos(time: f64) -> u64 {
    (time * 1.0e9) as u64
}

fn get_timestamp(time: f64) -> Timestamp {
    let time_nanos = seconds_to_nanos(time);
    Timestamp::new(
        (time_nanos / 1_000_000_000) as u32,
        (time_nanos % 1_000_000_000) as u32,
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
enum Row {
    Info(Info),
    Sphere(Sphere),
    Temperature(Temperature),
}

impl Row {
    fn get_time(&self) -> Option<f64> {
        match self {
            Row::Info(_) => None,
            Row::Sphere(sphere) => Some(sphere.time),
            Row::Temperature(temperature) => Some(temperature.time),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename = "info")]
struct Info {
    start: f64,
    end: f64,
    sphere_count: u64,
    temperature_count: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename = "sphere")]
struct Sphere {
    id: String,
    time: f64,
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename = "temperature")]
struct Temperature {
    time: f64,
    ambient: f64,
    cpu0: f64,
    cpu1: f64,
    cpu2: f64,
    cpu3: f64,
}

const TEMPERATURE_SCHEMA: &[u8] = br#"{
    "description": "cpu temperatures",
    "properties": {
        "time": {
            "description": "time of measurement",
            "type": "number"
        },
        "ambient": {
            "description": "ambient temperature (celsius)",
            "type": "number"
        },
        "cpu0": {
            "description": "cpu0 temperature (celsius)",
            "type": "number"
        },
        "cpu1": {
            "description": "cpu1 temperature (celsius)",
            "type": "number"
        },
        "cpu2": {
            "description": "cpu2 temperature (celsius)",
            "type": "number"
        },
        "cpu3": {
            "description": "cpu3 temperature (celsius)",
            "type": "number"
        }
    },
}"#;

impl From<&Sphere> for Message {
    fn from(sphere: &Sphere) -> Message {
        let sphere_primitive = SpherePrimitive {
            pose: Some(Pose {
                position: Some(Vector3 { x: sphere.x, y: sphere.y, z: sphere.z }),
                orientation: Some(Quaternion { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }),
            }),
            size: Some(Vector3 { x: 0.1, y: 0.1, z: 0.1 }),
            color: Some(Color { r: 1.0, g: 0.6, b: 0.0, a: 1.0 }),
        };
        let time_nanos = seconds_to_nanos(sphere.time);
        let entity = SceneEntity {
            timestamp: Some(get_timestamp(sphere.time)),
            frame_id: "scene".to_string(),
            id: sphere.id.clone(),
            lifetime: None,
            frame_locked: false,
            metadata: vec![],
            arrows: vec![],
            cubes: vec![],
            spheres: vec![sphere_primitive],
            cylinders: vec![],
            lines: vec![],
            triangles: vec![],
            texts: vec![],
            models: vec![],
        };
        Message {
            channel_id: SPHERE_CHANNEL_ID,
            log_time: time_nanos,
            publish_time: time_nanos,
            data: SceneUpdate {
                deletions: vec![],
                entities: vec![entity],
            }.encode_to_vec(),
        }
    }
}

impl From<&Temperature> for Message {
    fn from(temperature: &Temperature) -> Message {
        let time = seconds_to_nanos(temperature.time);
        Message {
            channel_id: TEMPERATURE_CHANNEL_ID,
            log_time: time,
            publish_time: time,
            data: serde_json::to_vec(temperature).expect("failed to stringify Temperature"),
        }
    }
}
