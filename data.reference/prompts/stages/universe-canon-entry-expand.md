# Universe — Expand Place / Object Entry

You are fleshing out one canon entry in a story universe so a novelist and a graphic novelist both have everything they need to write and render it consistently.

This entry's kind is: **{{kind}}**

## Universe style / aesthetic

{{styleClause}}

## The entry

Current data — fields that are already populated MUST be preserved verbatim. Only fill BLANK fields. Empty string `""` or `null` means blank.

```json
{{entryJson}}
```

## Other entries of the same kind in this universe (peers — DO NOT collide)

```json
{{peersJson}}
```

## Task

For every BLANK field below that applies to this entry's kind, propose a value that:

1. **Fits the universe's aesthetic** and whatever the entry already establishes.
2. **Stays distinct from every peer.** Two taverns must not share a palette; two relics must not share a silhouette or a purpose.
3. **Reads as image-gen-ready prose** for the descriptive fields. Dense, specific, single paragraphs. No bullet points inside string values.
4. **Invents nothing that contradicts** an already-populated field.

### Field guidance — `place`

- `description` — 50–100 words of stable, concrete, image-generation identity: scale, architecture or terrain, materials, light quality, signature fixtures, state of repair, and what the space is FOR. Never substitute the location's name for visible detail.
- `palette` — the dominant colors and their sources ("sodium-orange street light on wet slate; brass fittings; oxidized copper trim").
- `era` — the period the built environment reads as ("late-industrial, retrofitted"; "pre-collapse arcology"; "timeless — no visible technology").
- `weather` — the ambient conditions the location is usually seen in ("perpetual low fog off the estuary; rain three days in four").
- `recurringDetails` — the small persistent things a reader should recognize across scenes ("the cracked third step; the noticeboard nobody clears; a radio always half a station off").
- `intExt` — exactly `INT` or `EXT`. Pick the one the location is predominantly shot in. Omit if genuinely both.
- `timeOfDay` — exactly one of `dawn`, `day`, `dusk`, `night` — the location's signature hour. Omit if it has none.

### Field guidance — `object`

- `description` — 50–100 words of stable, concrete, image-generation identity: size in the hand or in the room, materials, finish and wear, markings, mechanism, how it moves or sounds. Never substitute the object's name for visible detail.
- `significance` — what the object MEANS in the story: who wants it, what it costs to hold, and what its presence in a scene signals. 2–4 sentences.

## Output contract

Return ONLY valid JSON, no markdown fence, no commentary. Include ONLY the keys you are proposing values for — if a field is already populated, or does not apply to this entry's kind, or you have nothing meaningful to add, OMIT the key entirely. Do not echo unchanged values.

```json
{
  "description": "string",
  "palette": "string",
  "era": "string",
  "weather": "string",
  "recurringDetails": "string",
  "intExt": "INT | EXT",
  "timeOfDay": "dawn | day | dusk | night",
  "significance": "string",
  "rationale": "1-sentence summary of the direction you chose"
}
```
