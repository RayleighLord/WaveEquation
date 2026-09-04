import "katex/dist/katex.min.css";
import "./styles/main.css";

import { startApp } from "./app";

const dispose = startApp();
if (import.meta.hot) import.meta.hot.dispose(dispose);
