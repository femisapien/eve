import { defineDynamic, once } from "eve";

export default defineDynamic({
  select: once,
  resolve: () => null,
});
