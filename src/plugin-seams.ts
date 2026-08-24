import type { createRecorder as CreateRecorder, Recorder } from "./stats/recorder"

export const seams: {
  factory: typeof CreateRecorder | null
  recorder: Recorder | null
} = {
  factory: null,
  recorder: null,
}

export function __setRecorderFactoryForTest(factory: typeof CreateRecorder | null): void {
  seams.factory = factory
}
export function __resetRecorderFactoryForTest(): void {
  seams.factory = null
}
export function __setRecorderForTest(recorder: Recorder | null): void {
  seams.recorder = recorder
}
export function __resetRecorderForTest(): void {
  seams.recorder = null
}
