declare module "*?worker" {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

declare module "*?raw" {
  const content: string;
  export default content;
}
