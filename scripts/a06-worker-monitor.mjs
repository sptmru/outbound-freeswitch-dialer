// Capture errors while the parent waits at a checkpoint, including before pool cleanup finishes.
export function monitorWorker(child, metadata) {
  const state = { ...metadata, pid: child.pid, code: null, signal: null, log: "", failure: null };
  const append = (data) => {
    state.log = (state.log + data.toString()).slice(-65536);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("message", (message) => {
    if (message.type === "failed") state.failure = message.error;
  });
  child.on("error", (error) => {
    state.failure = { message: error.message, code: error.code };
  });
  const ended = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      state.code = code;
      state.signal = signal;
      if (code !== 0) state.failure ??= { message: `Worker exited (${code ?? signal})` };
      resolve({ code, signal, log: state.log });
    })
  );
  return { child, state, ended };
}

export function assertWorkersHealthy(workers) {
  for (const { state } of workers) {
    if (state.failure) throw new Error(`A06 worker failed: ${JSON.stringify(state)}`);
  }
}
