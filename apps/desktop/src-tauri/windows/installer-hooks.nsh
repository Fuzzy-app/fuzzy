!macro NSIS_HOOK_PREINSTALL
	; セットアップは常にFuzzyの管理データを初期状態から作り直す。
	; 利用者が選んだ大学資料の保存先はこのフォルダーの外にあるため触れない。
	SetShellVarContext current
	RMDir /r /REBOOTOK "$LOCALAPPDATA\Fuzzy"
	RMDir /r /REBOOTOK "$APPDATA\Fuzzy"
!macroend

!macro NSIS_HOOK_POSTINSTALL
	; 利用者にコマンド操作を要求せず、同梱ホストとブラウザの登録を完了する。
	ExecWait '"$INSTDIR\Fuzzy.exe" --register-native-host' $0
	${If} $0 != 0
		MessageBox MB_ICONEXCLAMATION|MB_OK "Native Messagingホストの自動登録に失敗しました。Fuzzyを起動すると自動修復を再試行できます。"
	${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
	; 新規接続を止める。保存処理中のhostを強制終了せず、ブラウザ終了後に安全に解放させる。
	MessageBox MB_ICONINFORMATION|MB_OK "資料の保存が完了していることを確認し、ブラウザを閉じてからアンインストールを続行してください。"
	ExecWait '"$INSTDIR\Fuzzy.exe" --unregister-native-host' $0
	DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\jp.ac.wakayama_u.fuzzy.native_host"
	DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\jp.ac.wakayama_u.fuzzy.native_host"
	DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\jp.ac.wakayama_u.fuzzy.native_host"
	Delete "$LOCALAPPDATA\Fuzzy\NativeMessaging\jp.ac.wakayama_u.fuzzy.native_host.json"
	; Fuzzyが管理する設定・SQLite・検索索引・キャッシュを削除する。
	; 利用者が選択した授業資料の保存先はこの配下ではないため触れない。
	RMDir /r /REBOOTOK "$LOCALAPPDATA\Fuzzy"
	RMDir /r /REBOOTOK "$APPDATA\Fuzzy"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
	; 使用中だったファイルが事前処理で残った場合も、アンインストール完了後に再度削除する。
	RMDir /r /REBOOTOK "$LOCALAPPDATA\Fuzzy"
	RMDir /r /REBOOTOK "$APPDATA\Fuzzy"
!macroend
