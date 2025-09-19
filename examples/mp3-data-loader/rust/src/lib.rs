use std::{collections::BTreeMap, io::Read, sync::Arc};

use foxglove::Encode;
use foxglove_data_loader::{
    DataLoader, DataLoaderArgs, Initialization, Message, MessageIterator, MessageIteratorArgs,
    reader::{self},
};

use anyhow::Context;

const NS_PER_S: u64 = 1_000_000_000;

#[derive(Default)]
struct Mp3DataLoader {
    path: String,
    content: Arc<Vec<u8>>,
    /// Index of timestamp to byte offset
    indexes: BTreeMap<u64, usize>,
    channel_id: u16,
}

impl DataLoader for Mp3DataLoader {
    type MessageIterator = Mp3MessageIterator;
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
        let mut reader = reader::open(&self.path);
        let size = reader.size();
        let mut buf = vec![0u8; size as usize];
        reader
            .read_exact(&mut buf)
            .context("failed reading MP3 data")?;
        let mut decoder = nanomp3::Decoder::new();
        let mut message_count: u64 = 0;
        let mut pos: usize = 0;
        let mut ts: u64 = 0;
        let mut pcm = [0f32; nanomp3::MAX_SAMPLES_PER_FRAME];
        while pos < buf.len() {
            let (consumed, frame_info) = decoder.decode(&buf[pos..], &mut pcm);
            if let Some(frame_info) = frame_info {
                self.indexes.insert(ts, pos);
                ts += len_ns(&frame_info);
                message_count += 1;
            }
            pos += consumed;
        }
        self.content = Arc::new(buf);
        let mut init = Initialization::builder().start_time(0).end_time(ts);
        let channel = init
            .add_encode::<foxglove::schemas::RawAudio>()?
            .add_channel("/audio")
            .message_count(message_count);
        self.channel_id = channel.id();

        Ok(init.build())
    }

    fn create_iter(
        &mut self,
        args: MessageIteratorArgs,
    ) -> Result<Self::MessageIterator, Self::Error> {
        let file_end_time = *self.indexes.last_entry().unwrap().key();
        let start_time = args.start_time.unwrap_or(0);
        if start_time > file_end_time {
            return Ok(Mp3MessageIterator::empty());
        }
        let end_time = args.end_time.unwrap_or(file_end_time);
        let mut range = self.indexes.range(start_time..=end_time);
        let Some((&cur_timestamp, &cur_pos)) = range.next() else {
            return Ok(Mp3MessageIterator::empty());
        };
        Ok(Mp3MessageIterator {
            decoder: nanomp3::Decoder::new(),
            content: self.content.clone(),
            channel_id: self.channel_id,
            cur_pos,
            cur_timestamp,
            until: end_time,
            last_encoded_message: Vec::new(),
        })
    }
}

fn len_ns(frame_info: &nanomp3::FrameInfo) -> u64 {
    (frame_info.samples_produced as u64 * NS_PER_S) / (frame_info.sample_rate as u64)
}

struct Mp3MessageIterator {
    decoder: nanomp3::Decoder,
    content: Arc<Vec<u8>>,
    channel_id: u16,
    cur_pos: usize,
    cur_timestamp: u64,
    until: u64,
    last_encoded_message: Vec<u8>,
}

impl Mp3MessageIterator {
    fn empty() -> Self {
        Self {
            decoder: nanomp3::Decoder::new(),
            content: Default::default(),
            channel_id: 0,
            cur_pos: 0,
            cur_timestamp: 1,
            until: 0,
            last_encoded_message: Vec::new(),
        }
    }
}

impl MessageIterator for Mp3MessageIterator {
    type Error = anyhow::Error;

    fn next(&mut self) -> Option<Result<Message, Self::Error>> {
        if self.cur_timestamp > self.until {
            return None;
        }
        let mut samples = [0f32; nanomp3::MAX_SAMPLES_PER_FRAME];
        while self.cur_pos < self.content.len() && self.cur_timestamp <= self.until {
            let (consumed, frame_info) = self
                .decoder
                .decode(&self.content[self.cur_pos..], &mut samples);
            self.cur_pos += consumed;

            let Some(frame_info) = frame_info else {
                continue;
            };
            let valid =
                &samples[..frame_info.samples_produced * frame_info.channels.num() as usize];
            let duration = len_ns(&frame_info);
            let log_time = self.cur_timestamp;
            self.cur_timestamp += duration;
            let sec = (log_time / NS_PER_S) as u32;
            let nsec = (log_time % NS_PER_S) as u32;
            let msg = foxglove::schemas::RawAudio {
                timestamp: Some(foxglove::schemas::Timestamp::new(sec, nsec)),
                format: "pcm-s16".into(),
                data: valid
                    .iter()
                    .flat_map(|&i| ((i * i16::MAX as f32) as i16).to_le_bytes())
                    .collect(),
                number_of_channels: frame_info.channels.num() as u32,
                sample_rate: frame_info.sample_rate,
            };
            self.last_encoded_message.clear();
            if let Err(err) = msg.encode(&mut self.last_encoded_message) {
                return Some(Err(err.into()));
            };

            return Some(Ok(Message {
                channel_id: self.channel_id,
                log_time,
                publish_time: log_time,
                data: self.last_encoded_message.clone(),
            }));
        }
        None
    }
}

foxglove_data_loader::export!(Mp3DataLoader);
