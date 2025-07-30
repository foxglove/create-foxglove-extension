use anyhow::anyhow;

use foxglove_data_loader::{
    DataLoader, DataLoaderArgs, Initialization, Message, MessageIterator, MessageIteratorArgs,
    reader::{self, Reader},
};

struct MyDataLoader {
    readers: Vec<Reader>,
}

impl DataLoader for MyDataLoader {
    type MessageIterator = MyMessageIterator;
    type Error = anyhow::Error;

    fn new(args: DataLoaderArgs) -> Self {
        let DataLoaderArgs { paths } = args;

        Self {
            readers: paths.iter().map(|path| reader::open(path)).collect(),
        }
    }

    fn initialize(&mut self) -> Result<Initialization, Self::Error> {
        anyhow::bail!("DataLoader::initialize not implemented")
    }

    fn create_iter(
        &mut self,
        _args: MessageIteratorArgs,
    ) -> Result<Self::MessageIterator, Self::Error> {
        anyhow::bail!("DataLoader::initialize not implemented")
    }
}

struct MyMessageIterator;

impl MessageIterator for MyMessageIterator {
    type Error = anyhow::Error;

    fn next(&mut self) -> Option<Result<Message, Self::Error>> {
        Some(Err(anyhow!("MessageIterator::next not implemented")))
    }
}

foxglove_data_loader::export!(MyDataLoader);
