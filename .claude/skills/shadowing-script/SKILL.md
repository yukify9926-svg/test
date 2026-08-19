---
name: shadowing-script
description: Formats English and Japanese text into the paste-ready script format for the shadowing practice app (英文の次の行に和訳、空行が項目の区切り). Use this whenever the user sends English text, Japanese text, or a bilingual pair and wants it prepared for the app — including when they just paste a passage with no instructions, or say things like シャドーイング用に, スクリプト形式で, 整形して, これを追加したい, 変換して, or ask for a transcript/article/dialogue to be turned into practice material. Also use when they hand over an already-translated pair and only need the line structure fixed.
---

# Shadowing script formatter

The shadowing app takes one pasted block holding both languages. This skill turns whatever the user sends — an article, a podcast transcript, a textbook page, a single sentence — into that block, ready to copy in one tap.

## The format

Each English line has its Japanese translation on the line directly below it. **A blank line ends one practice item and starts the next** — everything between two blank lines is spoken as a single recording.

```
Hey, do you have a minute?
ちょっといいですか?
Sure, what's up?
もちろん、どうしました?

Thanks, that really helps.
ありがとう、助かります。
```

That is two items: a two-turn exchange practised in one run, then a standalone line.

The app decides a line's role by looking at its characters: a line containing kana or kanji is a translation, and within an item the English lines and Japanese lines pair up by position. That is the whole mechanism, which leads to the constraints that matter:

- **Every item starts with English.** A Japanese line with no English above it has nothing to pair with, and the app rejects the paste.
- **Never break a sentence across lines.** A line break inside an item becomes a pause in the reading.
- **Keep Japanese out of the English lines.** Romanised names and Latin-alphabet loanwords are fine; kana or kanji in an English line makes the app read that line as a translation.
- **Blank lines are structural.** They are the only thing separating items, so never use one for visual spacing inside a passage.

## Producing the output

Put the finished block in a fenced code block and nothing else inside it — no commentary, no numbering, no speaker labels, no headings. The user copies the block with one tap and pastes it straight into the app, so anything extra becomes a script they have to delete by hand.

Outside the code block, keep remarks short. Say how many items there are, and flag anything you were unsure about (an ambiguous sentence, a term you translated a particular way). Skip the preamble otherwise.

## Deciding how much goes in one item

The app does no splitting of its own, so where you put the blank lines decides what the user practises in one run. That is a judgement about the material, not a formatting detail.

**Conversation goes in one item.** An exchange only works as practice if the turns follow each other the way they would in speech — the rhythm of a reply landing on a question is most of what makes dialogue worth shadowing. Keep a whole exchange together, one turn per line, and use blank lines only between separate scenes. A four to eight turn exchange is a comfortable run.

```
Hey, do you have a minute?
ちょっといいですか?
Sure, what's up?
もちろん、どうしました?
I wanted to ask about the schedule for next week.
来週のスケジュールについて聞きたくて。
```

**Continuous prose goes in paragraph-sized items.** For an article or a transcript, keep a few sentences that carry one thought together — one sentence per line inside the item — so the user practises the passage as it was written rather than as disconnected fragments. Roughly three to six sentences per item; past that a single take is hard to hold.

**Single sentences get their own item** when the user is collecting phrases to drill, or when the material really is a list of unrelated examples.

When the material is ambiguous, prefer the longer run — the user can always practise a part of it with the A-B repeat, but the app cannot join items back together.

Say which grouping you chose and give the item count, since the user may want a different granularity.

Split on real sentence boundaries, not on every period. `Mr.`, `Dr.`, `U.S.`, `e.g.`, `No. 5`, `3.5%`, and decimal points all end up mid-sentence — splitting there produces fragments that make no sense to practise. Read the text rather than pattern-matching on punctuation.

Some things belong together even across a period:

- A quotation and its attribution: `"We'll see," she said.` is one line.
- A short sentence that only makes sense with its neighbour, such as a two-word reply following its setup.
- Sentences the user has already grouped, when they clearly want them as one unit.

Very long sentences (roughly 40 words and up) are hard to shadow whole. Splitting a long sentence at a semicolon or a coordinating conjunction is reasonable when both halves stand alone — but say so in your remarks, since the user may want it intact.

## Translating

When the user supplies only English, write the Japanese yourself. Aim for the translation a learner would want beside the sentence: natural Japanese that still tracks the English closely enough to show how the sentence is built. A translation that reorganises the sentence for elegance hides the structure the user is trying to internalise, and one that follows the English word by word stops being Japanese. Sit between those.

When the user sends Japanese only, write the English — plain, spoken-register English of the kind worth practising aloud, not a literary rendering.

When the user supplies both languages, their translation is the one to keep. Reformat the lines and leave the wording alone. If a pair is genuinely misaligned or a translation is missing, fix it and mention the change outside the code block rather than silently rewriting.

## Handling what people actually paste

**Dialogue with speaker names.** Drop the labels — they would be read aloud in the recording, and a bare `Clerk:` line parses as English with no translation. The turns are already separated by their line breaks. If knowing who speaks matters, carry it in the Japanese instead (`(店員)いらっしゃいませ。`).

**Headings, timestamps, bylines, footnotes.** Leave them out. They are not sentences to shadow.

**Text with existing line breaks.** Transcripts often wrap mid-sentence. Rejoin the sentence before pairing it; the source's line breaks carry no meaning here.

**Long passages.** Format the whole thing, grouped into paragraph-sized items. Only summarise or excerpt if the user asks.

**One recording per item.** Each item is sent to the speech API as a single request, so a long item costs one generation rather than several — but it also means an item cannot be regenerated in parts.

## Example

The user pastes:

> The board approved the merger on Tuesday. Shares rose 4% in after-hours trading. "This is a good outcome for everyone," the CEO said.

Your reply:

```
The board approved the merger on Tuesday.
取締役会は火曜日にその合併を承認しました。
Shares rose 4% in after-hours trading.
株価は時間外取引で4%上昇しました。
"This is a good outcome for everyone," the CEO said.
「これは全員にとって良い結果です」とCEOは述べました。
```

3文で1項目です。ひと続きの話なので通しで練習できるようにまとめました。1文ずつ分けたい場合は言ってください。
