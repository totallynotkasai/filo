/** A file's text, as Vite's `?raw` import gives it (a spec compiling a component's styles). */
declare module '*?raw' {
  const text: string;
  export default text;
}
