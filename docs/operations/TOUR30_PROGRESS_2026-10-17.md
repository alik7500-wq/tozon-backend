# Tour 30 / Unit 83 — verified progress

Scope: Supabase project yeslzrrcwgcqfxhgbrqk; project 3; unit 83; tour 30.

Production remains inactive. All five current panorama files are in private bucket `panoramas-360-drafts`, not public bucket `panoramas-360`. Do not activate merely by changing is_active: getTourTree changes buckets on activation.

## Applied production change

Hotspot 71 only: panorama 55, target 56 -> 57; label `В гостинную` -> `В гостиную`. Original updated_at: `2026-10-17T16:09:58.600Z`. A transaction checked the owning tour/project/unit/inactive state and exact previous target/label, then asserted exactly one affected row. Readback confirmed 55 -> 57.

All hotspots outside tour 30 were unchanged: before and after MD5 of jsonb_agg(to_jsonb(h) order by h.id) is `03d7547650f9a7aa01fdccc3e2304243`.

Other original hotspots (not changed in this task):

| ID | From | Target | Label |
| --- | --- | --- | --- |
| 64 | 59 | 55 | В корридор |
| 66 | 57 | 55 | В санузел |
| 67 | 57 | 55 | В корридор |
| 68 | 57 | 55 | В спальню |
| 69 | 56 | 55 | В корридор |
| 70 | 55 | 56 | В спальню |
| 72 | 55 | 56 | В кухню |

## Remaining release work

- Inspect the actual private source panoramas through an authorized storage/session channel.
- Correct the remaining doorway positions and targets. Required relationship from owner: corridor <-> living <-> kitchen; no direct corridor <-> kitchen.
- Edit kitchen 58 non-destructively to add a doorway to living; validate equirectangular projection, seam and 8192x4096 dimensions.
- Add reciprocal kitchen -> living hotspot at the actual doorway angle.
- Verify every room is reachable and every required edge has a reverse; confirm no destinations outside tour 30.
- Copy only this tour's five verified assets into public storage, verify sizes/checksums and read URLs, then activate only tour 30 in a guarded transaction.
- Test apartment 83 button and confirm other apartments do not display this tour.

Render listing requires explicit workspace confirmation from the user. Available workspace: Акмалхон's workspace (tea-da2pspoae00c73cmljg0). No Render workspace was selected and no deployment was triggered during this task.
