import "./app.css";

const target = document.getElementById("app");
if (!target) {
	throw new Error("ポップアップの描画先 #app が見つかりません");
}

target.innerHTML = `
	<main class="fuzzy-popup">
		<p class="fuzzy-popup-kicker">Fuzzy</p>
		<h1>締切ハブは Moodle 上で開きます</h1>
		<p class="fuzzy-popup-body">
			今回の画面はポップアップではなく、Moodle上部ナビに追加される「Fuzzy」から確認してください。
		</p>
		<ol class="fuzzy-popup-steps">
			<li>Moodleを開く</li>
			<li>上部ナビの「Fuzzy」を押す</li>
			<li>締切ハブ画面が切り替わることを確認する</li>
		</ol>
	</main>
`;
