import "./app.css";

const target = document.getElementById("app");
if (!target) {
	throw new Error("ポップアップの描画先 #app が見つかりません");
}

target.innerHTML = `
	<main class="fuzzy-popup">
		<p class="fuzzy-popup-kicker">Fuzzy</p>
		<h1>Moodle上で確認してください</h1>
		<p class="fuzzy-popup-body">
			今回の画面は拡張機能のポップアップではなく、Moodleの上部ナビに追加される
			「Fuzzy」タブから開きます。
		</p>
		<ol class="fuzzy-popup-steps">
			<li>Moodleを開く</li>
			<li>上部ナビの「Fuzzy」を押す</li>
			<li>横断検索または締切ハブが開くことを確認する</li>
		</ol>
	</main>
`;
