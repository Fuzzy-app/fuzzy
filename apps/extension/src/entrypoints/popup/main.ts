import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) {
	throw new Error("ポップアップのマウント先 #app が見つかりません");
}

const app = mount(App, { target });

export default app;
