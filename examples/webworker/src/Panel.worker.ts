const scope = self as unknown as Worker;

type WorkerInterface = Worker & (new () => Worker);

setInterval(() => {
  scope.postMessage("hello world from worker!");
}, 1000);

export default {} as WorkerInterface;
