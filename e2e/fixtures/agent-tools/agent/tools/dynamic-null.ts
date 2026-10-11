import { defineDynamic, once } from "eve/tools";

export default defineDynamic({
  select: once,
  build: () => {
    return null;
  },
});
