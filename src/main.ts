import "./style.css";
import { ChessUI } from "./ui";

const app = document.querySelector<HTMLDivElement>("#app")!;
new ChessUI(app);
