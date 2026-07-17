# WebClass Deadline Viewer

参加しているコースの利用可能期間や提出期限を一覧表示するChrome / Edge拡張機能です。

## 主な機能

- コースの利用可能期間と提出期限を一覧表示
- 期限の近い項目、受付中、終了済み、提出済みで絞り込み
- 許可したWebClassサイトから情報を一括取得
- 表示設定と取得結果をブラウザ内に保存

## 使い方

1. 拡張機能の設定画面を開きます。
2. 利用するWebClassサイトを追加して、アクセスを許可します。
3. WebClassページを再読み込みすると、期限一覧が表示されます。

## 開発版の読み込み

1. `chrome://extensions`（Edgeは`edge://extensions`）を開きます。
2. デベロッパーモードを有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリを選択します。

## 権限

- `storage` — 設定と表示用データを保存するため
- `tabs` — 一括取得時にバックグラウンドでタブを操作するため
- `scripting` — 許可済みのWebClassページへ表示機能を登録するため
- 任意のサイトアクセス — ユーザーが許可したWebClassサイトでのみ動作するため

## 関連リンク

- [Chrome Web Store](https://chromewebstore.google.com/detail/hepbhmpfaidklleailhbemkeghpjgden)
- [プライバシーポリシー](https://extensions.ouma3.org/policies/webclass-deadline-viewer/)
- [お問い合わせ](https://extensions.ouma3.org/contact/)
