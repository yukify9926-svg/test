---
name: shadowing-script
description: Formats English and Japanese text into the paste-ready script format for the shadowing practice app (英文の次の行に和訳、ペア間は空行). Use this whenever the user sends English text, Japanese text, or a bilingual pair and wants it prepared for the app — including when they just paste a passage with no instructions, or say things like シャドーイング用に, スクリプト形式で, 整形して, これを追加したい, 変換して, or ask for a transcript/article/dialogue to be turned into practice material. Also use when they hand over an already-translated pair and only need the line structure fixed.
---

# Shadowing script formatter

The shadowing app takes one pasted block holding both languages. This skill turns whatever the user sends — an article, a podcast transcript, a textbook page, a single sentence — into that block, ready to copy in one tap.

## The format

Each English sentence sits on its own line with its Japanese translation on the line directly below it. A blank line separates pairs.

```
I've been meaning to reach out to you.
ずっと連絡しようと思っていました。

Let's circle back to this next week.
この件は来週また改めて話しましょう。
```

The app decides a line's role by looking at its characters: a line containing kana or kanji is a translation and attaches to the English above it. That is the whole mechanism, which leads to the constraints that matter:

- **The block starts with English.** A Japanese line with no English above it has nothing to attach to, and the app rejects the paste.
- **Never break a sentence across lines.** A line ending is a record separator, so a wrapped sentence becomes two entries.
- **Keep Japanese out of the English lines.** Romanised names and Latin-alphabet loanwords are fine; kana or kanji in an English line makes the app read that line as a translation.

## Producing the output

Put the finished block in a fenced code block and nothing else inside it — no commentary, no numbering, no speaker labels, no headings. The user copies the block with one tap and pastes it straight into the app, so anything extra becomes a script they have to delete by hand.

Outside the code block, keep remarks short. Say how many pairs there are, and flag anything you were unsure about (an ambiguous sentence, a term you translated a particular way). Skip the preamble otherwise.

## Splitting into sentences

One sentence per pair is the default, because the app practises one entry at a time and a lone sentence is the right size to shadow.

Split on real sentence boundaries, not on every period. `Mr.`, `Dr.`, `U.S.`, `e.g.`, `No. 5`, `3.5%`, and decimal points all end up mid-sentence — splitting there produces fragments that make no sense to practise. Read the text rather than pattern-matching on punctuation.

Some things belong together even across a period:

- A quotation and its attribution: `"We'll see," she said.` is one pair.
- A short sentence that only makes sense with its neighbour, such as a two-word reply following its setup.
- Sentences the user has already grouped, when they clearly want them as one unit.

Very long sentences (roughly 40 words and up) are hard to shadow whole. Splitting a long sentence at a semicolon or a coordinating conjunction is reasonable when both halves stand alone — but say so in your remarks, since the user may want it intact.

## Translating

When the user supplies only English, write the Japanese yourself. Aim for the translation a learner would want beside the sentence: natural Japanese that still tracks the English closely enough to show how the sentence is built. A translation that reorganises the sentence for elegance hides the structure the user is trying to internalise, and one that follows the English word by word stops being Japanese. Sit between those.

When the user sends Japanese only, write the English — plain, spoken-register English of the kind worth practising aloud, not a literary rendering.

When the user supplies both languages, their translation is the one to keep. Reformat the lines and leave the wording alone. If a pair is genuinely misaligned or a translation is missing, fix it and mention the change outside the code block rather than silently rewriting.

## Handling what people actually paste

**Dialogue with speaker names.** Drop the labels — they are not part of what gets spoken in practice, and they would be parsed as English lines with no translation. If knowing the speaker matters for a line, carry it in the Japanese instead (`(店員)いらっしゃいませ。`).

**Headings, timestamps, bylines, footnotes.** Leave them out. They are not sentences to shadow.

**Text with existing line breaks.** Transcripts often wrap mid-sentence. Rejoin the sentence before pairing it; the source's line breaks carry no meaning here.

**Long passages.** Format the whole thing. The app registers each pair as its own entry, so a 30-sentence article becomes 30 practice items, which is the point. Only summarise or excerpt if the user asks.

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

3ペアです。3文目は引用と発言者を1つのペアにまとめています。
