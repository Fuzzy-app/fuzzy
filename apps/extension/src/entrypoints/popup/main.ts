import "@fuzzy/shared/theme.css";
import { POPUP_NAVIGATION_GUIDE } from "../../lib/ui/screenCopy";
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
			Fuzzyの画面は拡張機能のポップアップではなく、Moodleのページ内に表示されます。
		</p>
		<ol class="fuzzy-popup-steps">
			<li>Moodleを開く</li>
			<li>資料の保存は、授業ページ右側の保存パネルから行う</li>
			<li>${POPUP_NAVIGATION_GUIDE}</li>
		</ol>
	</main>
`;
