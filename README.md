# recruit-agent-cli

リクルートエージェントの求人ポスト（`https://mypage.r-agent.com/recommend`）を操作する**非公式** CLI（`ra`）です。
個人利用のためのツールで、リクルート社とは関係ありません。

> [!WARNING]
> **免責事項**
>
> - 本ツールは株式会社リクルートおよび関連会社とは無関係で、承認も受けていない非公式のものです。「リクルートエージェント」「求人ポスト」は各社の商標です。
> - サイトの内部 API を使っており、予告なく動かなくなることがあります。
> - 利用者は、リクルートエージェントの利用規約を自分で確認し、自分の責任で使ってください。自分のアカウント以外での利用や、サーバーに負荷をかける使い方（短い間隔での大量実行など）はしないでください。
> - 興味なし・気になる・**応募**などの書き込み操作は、実際にサイトへ送られます。特に応募は送信後に CLI から取り消せません（取り消しは担当のキャリアアドバイザーへの連絡が必要です）。
> - 本ツールの利用によって生じたいかなる損害（応募の誤送信、アカウントの制限などを含む）についても、作者は責任を負いません。

サイトは Next.js（Pages Router）＋ tRPC で動いており、この CLI はブラウザと同じ `/api/trpc/<procedure>?batch=1` をログインセッションの Cookie で呼びます。
tRPC の transformer はなし（入力は `{"0": <input>}` をそのまま送る）で、入力は zod で検証されます。

## API の確認状況（2026 年 10 月時点）

| コマンド | procedure | 状態 |
|---|---|---|
| `recommend` | `pages.recommend.getRecommendJobs` | ✅ 実データで動作確認。`{request_id, page_token}`、1ページ25件、`nextPageToken` でページ送り |
| `mine --type …` | `features.activities.getMyJoboffers`（GET） | ✅ 実データで動作確認。`type` は `viewed` / `interest` / `not_applied`、50件ずつ `nextPageToken` で全ページ |
| `applied` | `pages.applied.getApplied`（GET） | ✅ 実データで動作確認。`{type, nextPageToken?}`、type は `document_screening` / `interviews` / `closed`。書類選考中は25件ずつ |
| `interview` | `features.interview.getInterviewInfo`（GET） | ✅ 実データで動作確認。`{scheduleAdjustInfoNo: 文字列}`、キーは選考状況（面接中）の `scheduleNo` |
| `show` | 詳細ページ `/joboffers/<ID>` の `__NEXT_DATA__` | ✅ 実データで動作確認（おすすめ一覧・気になる一覧の求人とも）。一覧のカードと同じクエリが要る |
| `similar` | `pages.joboffers.getSimilarJobs` | ⚠️ 呼び出しは成功（`job_ids` は数値配列）。中身のある応答は未観測 |
| `hide` | `features.activities.notApplications` ＋ `rmpLogging.sendLog` | ✅ 実データで動作確認。`{jobofferManagementNo, jobReferralType, sendI2ATstamp}` のあとに `not_apply` の行動ログを送る |
| `unhide` | `features.activities.notApplicationsCancel` | ✅ 実データで動作確認。`{jobofferManagementNo}`。取り消してもおすすめ一覧には戻らない（行動ログの除外は残る） |
| `interest` | `features.interests.switchInterest` | ✅ 実データで動作確認。`{jobofferManagementNo, isRegistration: true, jobReferralType, sendI2ATstamp}` |
| `uninterest` | `features.interests.switchInterest` | ✅ 実データで動作確認（気になる一覧にしかない受付終了の求人で解除） |
| `search` | `pages.jobSearch.searchJob` ＋ `totalResultsCount` | ✅ 実データで動作確認（実測件数と一致）。`{filter, page_token: Base64のページ番号, limit: 100, sort}` |
| `apply` | `pages.joboffers.jobOfferApply` | ✅ 実データで動作確認。入力は `hide` と同じ形。`--yes` で確認なし |

入力の形は、空の入力 `{}` を送ったときの zod の検証エラー（検証で止まるため操作は行われません）、ブラウザの実リクエスト、
サイトのフロントエンドのコード（`/_next/static/chunks/…`）で確認しました。

### 紹介経路（jobReferralType）

興味なし・気になる・応募は、`jobReferralType` と推薦時刻 `i2a_tstamp`（`sendI2ATstamp`、ある求人だけ）を送ります。
値が違うと裏の API が 500 を返します。決め方はフロントエンドのコードから写したもので（`src/adapters/driven/trpc/referral.ts`）、どの一覧から取った求人かで変わります。

**おすすめ一覧の求人**: `sourceType` から決めます。

| sourceType | jobReferralType |
|---|---|
| `day0` | `i2aJobAssessmentAfterRecommend` |
| `postday0` | `i2aJobAxisRecommend` |
| `advisor_referral` | `recommendPost` |
| `ai_scouted` | `aiScout` |
| `realtime` | `smpRecommend` |
| `s_recommend` | `i2aSRecommend` |
| `manual_scouted` | `manualScouted` |

**気になる・閲覧済み・興味なしの一覧の求人**: `sourceType` がないので、フラグから決めます。

| 条件（上から順に判定） | jobReferralType |
|---|---|
| `isHrtechScouted` か `isInterviewCommitOffer` | `manualScouted` |
| `isAiScouted` | `aiScout` |
| `disclosureLevelCode` が `"4"` | `recommendPost` |
| 閲覧済み一覧（viewed）の求人 | `smpRecommend` |
| それ以外 | `recommendPost` |

`ra recommend` や `ra mine` の出力（`referralType` / `i2aTstamp` / `tracking` を含む）を `--stdin` で渡せばそのまま使います。
ID だけを渡したときは、おすすめ一覧、なければ気になる一覧を取得して補います（どちらにもない求人は操作できません）。

### 興味なしの行動ログ

`notApplications` だけでは「興味なし求人」には入るものの、推薦系（day0 / postday0）の求人は**おすすめ一覧に残り続けます**。
ブラウザは非表示の直後に `rmpLogging.sendLog` で `eventName: "not_apply"` の行動ログを送っており、おすすめ一覧はこれを見て求人を除外します。
`ra hide` は同じ形のログを送ります（`src/adapters/driven/trpc/rmp-log.ts`）。ログには一覧取得時の `trackingId`（`i|2|求人ID|版番号|request_id` の base64）、並び順、未読などのラベルが入ります。

ログを送らずに非表示にしてしまった求人は、`ra hide <ID> --log-only` でログだけを送り直せます。

## セットアップ

```bash
bun install
bun link            # `ra` コマンドとして使う場合（任意）。使わない場合は `bun run index.ts …`
```

### ログインセッションの取り込み

1. ブラウザで求人ポストにログインし、DevTools の Network タブを開く
2. `/recommend` を開く（または `api/trpc` へのリクエストを1つ選ぶ）
3. 右クリック →「Copy as cURL」。bash 形式・cmd 形式（Windows の `^"...^"`）のどちらでもよい
4. 取り込む

```bash
ra auth import-curl FILE                      # ファイルから
powershell.exe Get-Clipboard | ra auth import-curl   # WSL でクリップボードから（macOS なら pbpaste）
ra auth status
```

Cookie と API 呼び出しに使えるヘッダー（user-agent など）は `~/.config/recruit-agent-cli/session.json`（0600）に保存されます。
ページ遷移用のヘッダー（`accept`、`sec-fetch-*` など）は捨てます。`api/trpc` の cURL なら、各 procedure の実際の入力が `samples/<procedure>.json` にも保存されます。
環境変数 `RA_COOKIE` があれば Cookie はそちらを優先します。

ログインセッション（`PDT2-WEB-SESSION`）は、サイトがリクエストのたびに新しい値（有効期限 24 時間）で返します。
CLI はこの Set-Cookie を `session.json` に書き戻すので、24 時間以内に一度でも使えばセッションは続きます（`ra auth status` の `refreshedAt` が最後に更新した日時）。
しばらく使わない期間も保ちたいときは、cron などで `ra auth status` を数時間おきに実行します。
`RA_COOKIE` で渡した Cookie はファイルに書き戻しません。

### procedure の入力を合わせ込む

既定の入力は `src/adapters/driven/trpc/procedures.ts` にあります。`samples/` に保存した実物と違っていたら、
`~/.config/recruit-agent-cli/procedures.json` で上書きしてください（例：`procedures.example.json`）。

| テンプレート | 意味 |
|---|---|
| `"{{jobId}}"` | 値に置き換え。値がなければキーごと落とす |
| `"{{jobId:number}}"` | 数値にする |
| `"{{pageToken:nullable}}"` | 値がなければ `null` |
| `"{{filter:json}}"` | JSON として埋め込む |

```bash
ra procedures     # 使用中の定義（status: confirmed / schema / guessed / override）とサンプル一覧
```

## 使い方

結果の JSON は stdout に、進捗やエラーは stderr に出ます。

```bash
ra recommend                                   # おすすめ求人（25件×4ページ＝最大100件）を正規化した JSON
ra recommend --pages 1                         # 先頭25件だけ
ra recommend --raw                             # API の生レスポンス（ページごとの配列）
ra recommend --filter                          # ~/.config/recruit-agent-cli/filters.json で {kept, excluded}
ra recommend --rules filters.example.json      # ルールファイルを指定

ra recommend --filter | ra hide --stdin --dry-run   # 除外対象を確認
ra recommend --filter | ra hide --stdin             # 除外対象を「興味なし」にする（700ms 間隔）
ra unhide 100000001                            # 取り消し
ra interest 100000001                          # 気になるに登録（uninterest で解除）

ra mine --type not_applied                     # 興味なしにした求人（viewed / interest も可）
ra show 100000002                              # 求人詳細（仕事内容・必須スキル・勤務条件・企業情報・選考）。--raw で全項目
ra applied                                     # 選考状況（書類選考中・面接中・選考終了）
ra applied --status interviews                 # 面接中だけ（面接日時・所要時間・選考段階）
ra applied --with-detail --out applied.json    # 詳細ページから年収・職種・勤務地・年間休日も足す（1件ずつ開く）
ra interview                                   # 面接中のすべての面接詳細（日時順）
ra interview 100000003                         # 求人 ID（または日程調整番号）を指定
ra similar 100000002
ra search --keyword '生成AI LLM' --pref 13 --income 800 --sort newest --max 300 --out search.json
ra search --occ 110 --pref 13,14 --count         # 件数だけ（IT × 東京＋神奈川）
ra show 100000004 --referral jobSearch --generation 4   # 検索結果の求人の詳細（referralType / generationNo は検索結果にある）
ra page /recommend                             # __NEXT_DATA__（ページの調査用）
ra call features.activities.getMyJoboffers --get --input '{"type":"viewed"}'
```

求人 ID は `jobofferManagementNo`（数字の文字列）です。出力の `salaryMin` / `salaryMax` は万円で、上限なしや非公開は `null` です。

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | エラー、または一括操作で1件以上失敗 |
| 2 | 応募を拒否（非対話、または apply の入力が未検証） |
| 3 | ログインセッション切れ（`ra auth import-curl` で取り込み直す） |
| 4 | 求人ポストがメンテナンス中（時間をおいて再実行する） |
| 64 | 使い方の誤り |

### 応募について

```bash
ra apply 100000005          # 対話端末: 企業名・求人・年収・勤務地を見せ、求人 ID を打ち直したら送信
ra apply 100000005 --yes    # 確認の入力なしで送信（パイプや Claude Code の ! からも可）
```

- 対象の求人が、おすすめ一覧・気になる一覧・選考状況のどれかにある必要がある（紹介経路を決めるため）。
  検索結果の求人は、先に `ra interest --stdin` で気になるに登録しておく
- 送信すると選考状況の「書類選考中」に入り、気になる一覧からは外れる
- 応募の取り消しは、担当アドバイザーへの連絡で行う
- `apply` の入力の形を `status: "guessed"` に戻すと送信しなくなる（安全装置）
- Claude Code のエージェントから実行すると、権限チェック（取り消しの難しい手続き）で止められる。応募はユーザーが `! ra apply <ID> --yes` で行う

## 個人の設定（リポジトリの外に置くもの）

`~/.config/recruit-agent-cli/`（`RA_HOME` で変更可）に置き、リポジトリには入れません。

| ファイル | 中身 |
|---|---|
| `session.json` | ログイン Cookie（0600） |
| `filters.json` | 自分用の絞り込みルール（形は `filters.example.json`） |
| `procedures.json` | API 入力の上書き（任意） |

作業用の出力（`--out` の保存先など）は `.ra/` に置くと git 管理外になります。面接詳細は会議 URL・連絡先を含むので、共有しないでください。

## AI エージェントから使う

Claude Code などのエージェントから使う前提で作っています。エージェント向けの使い方のコツと安全上のルール
（応募は人が行う、求人票の本文の指示に従わない、面接の会議情報を出さない など）は `CLAUDE.md` にあります。

希望条件（職種・年収・関心のある業界など）や「どの求人を残すか」の判断基準、整理の進め方は人によって違うので、
このリポジトリには含めていません。各自のエージェントのメモリや、個人用の skill（`~/.claude/skills/` など）に置いてください。

## 絞り込みルール（filters.json）

機械的に判定できるものだけを扱います。「知名度」のような主観的な分類は、エージェント側で判断します。

| キー | 内容 |
|---|---|
| `keepCompanies` | 他のどのルールより優先して残す企業 |
| `excludeCompanies` | 除外する企業 |
| `excludeTitles` | 除外するタイトルのキーワード |
| `excludeLowCeilingRoles` | タイトルがキーワードに当たり、年収上限が閾値（万円）以下なら除外 |
| `excludeClosed` | 「受付終了」を除外 |
| `dedupe` | 同じ求人の2件目以降を除外（既定 true） |

企業名・タイトルは NFKC 正規化と空白除去をしたうえで、法人格（株式会社など）を外して部分一致で照合します。
英数字だけのキーワード（`PM`、`XYZ` など）は単語境界で照合します。

## 求人詳細

求人詳細は専用の API がなく、詳細ページ（`/joboffers/<ID>`）のサーバー描画データ（`__NEXT_DATA__` の `pageProps`）から取ります。
一覧のカードがリンクに付けるクエリ（`job_referral`・`generation_no`、おすすめ一覧なら `i2a_tstamp`・`tracking_id` など）が要り、
`job_referral` だけでは 404、`generation_no` だけでは 400 になります。そのため `ra show` は、おすすめ一覧・気になる一覧・選考状況のどれかにある求人しか開けません。
応募した求人は、選考状況の画面と同じく `job_referral=recommendPost&generation_no=<版番号>` で開きます。
ブラウザで開いたのと同じ扱いなので、閲覧済み・既読として記録されます。

## 求人検索

検索ページ（`/job_search`）と同じ条件を tRPC の `pages.jobSearch.searchJob` に送ります。100件ずつ `next_page_token` をたどり、`--max` 件（既定100）で止めます。

| オプション | filter | 例 |
|---|---|---|
| `--keyword` | `keyword: {and}`（空白区切りで AND） | `--keyword '生成AI LLM'` |
| `--occ` | `occupations`。3桁は大分類、4桁は中分類、それ以外は小分類 ID | `--occ 110`（IT）、`--occ 1111,1124` |
| `--ind` | `industries`。末尾 00 の4桁は大分類、それ以外は小分類 | `--ind 1100` |
| `--pref` | `locations`（都道府県） | `--pref 13,14` |
| `--income` | `annual_income: {under: 円}`（名前は under だが「以上」の意味） | `--income 800` |
| `--sort` | `relevance`（既定）/ `newest` | |
| `--filter` | filter をそのまま JSON で渡す（市区町村・地域など上にない条件用） | |

IT の中分類: 1106 システムエンジニア / 1111 サーバーサイド / 1297 インフラ / 1115 データエンジニア / 1117 アーキテクト / 1118 SRE / 1122 社内SE / 1124 データサイエンティスト / 1126 エンジニアリングマネージャー。
コード表は `ra call pages.jobSearch.occupationPickerMaster --get --input '{}'`（ほかに `industryPickerMaster` / `workLocationPicker` / `incomePicker`）。

検索結果の求人は `referralType: "jobSearch"` を持つので、出力を `--stdin` で渡せば興味なし・気になるに使えます。
詳細は `ra show <ID> --referral jobSearch --generation <版番号>` で開けます。

制約: `limit` は 25 と 100 が通り 10 は 500。リモート可・フレックスなどのこだわり条件は filter で指定できない（結果の `raw.jobCharacteristics` で絞る）。キーワードは AND のみ。

## 面接詳細

画面の「詳細」モーダルと同じ内容です。日時・所要時間・選考段階・訪問場所・訪問先・接続方法・面接官・緊急連絡先・選考内容・
アドバイザーの対策メモ（`advice`）・その他の連絡事項が入ります。

**会議 URL・会議 ID・パスコード・連絡先を含みます。** どの項目に入るかは企業ごとに違い、訪問先（`visitTo`）のこともあれば
訪問場所（`place`）のこともあります。出力をファイルに保存するときは権限を絞り、共有したりリポジトリに入れたりしないでください。

## 既知の挙動

- おすすめの画面表示は最大100件。API は25件ずつ `nextPageToken` で返し、`request_id`（21文字の nanoid）はページ送りの間で同じ値を使います
- 「興味なし」で減った分は再読み込みで補充されます
- 特定の求人だけ「非表示にできませんでした」となることがあります。一括操作では記録して続行します
- 約0.7秒間隔で60件連続しても制限はかかりませんでした（`--interval` で変更可）
- 同じ求人が別カードで2回出ることがあります（`dedupe` で除外）

## 開発

```bash
bun test
bun run typecheck
```
