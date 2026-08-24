declare module "solid-js" {
  export function createEffect(...args: any[]): any
  export function createMemo(...args: any[]): any
  export function createSignal<T>(value: T): [() => T, (v: T) => void]
  export function on(...args: any[]): any
  export function onCleanup(fn: () => void): void
}
declare module "@opentui/solid/jsx-runtime" {
  export function jsx(...args: any[]): any
  export function jsxs(...args: any[]): any
  export function jsxDEV(...args: any[]): any
}
declare module "@opentui/solid/jsx-dev-runtime" {
  export function jsx(...args: any[]): any
  export function jsxs(...args: any[]): any
  export function jsxDEV(...args: any[]): any
}
