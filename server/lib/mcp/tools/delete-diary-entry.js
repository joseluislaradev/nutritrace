/** Remove exactly one nutritional food entry; never a whole day or body stats. */
import { entryTargetSchema, resolveEntryTarget, itemsRevision } from '../_entry-target.js';
import { z } from 'zod';
import { DATE_RE, todayLocal, toolResult, toolError, isCalendarDate } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

export function registerDeleteDiaryEntry(server, { userId }) {
  server.registerTool(
    'delete_diary_entry',
    {
      title: 'Delete Diary Entry',
      description:
        'Remove exactly one food item from the authenticated user\'s day. ' +
        'First read list_diary_entries; pass item.uuid as entry_id (preferred) and ' +
        'items_revision as expected_revision. Legacy index requires the same revision. ' +
        'Conflicts require a fresh read and confirmation. Requires confirm=true. ' +
        'Preserves water, notes, body measurements and the day itself.',
      inputSchema: {
        ...entryTargetSchema,
        date:        z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        confirm:     z.boolean(),
      },
    },
    async ({ entry_id, entry_index, expected_revision, date, confirm }) => {
      const day = date || todayLocal();
      if (!isCalendarDate(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      if (confirm !== true) {
        return toolError(
          'delete_diary_entry requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true ' +
          "and re-invoke if you're sure."
        );
      }

      let removed = null;
      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => {
          entry_index = resolveEntryTarget(cur.items, {entry_id, entry_index, expected_revision});
          removed = cur.items[entry_index];
          const items = cur.items.slice(0, entry_index).concat(cur.items.slice(entry_index + 1));
          return { ...cur, items };
        });
      } catch (e) {
        if (e instanceof DiaryTombstonedError) return toolError(e.message);
        if (e instanceof RangeError)           return toolError(e.message);
        throw e;
      }

      return toolResult({
        ok: true,
        date: day,
        entry_id: removed?.uuid,
        items_revision: itemsRevision(next.items),
        removed: {
          name:            removed?.name,
          brand:           removed?.brand,
          meal:            removed?.meal,
          portion:         removed?.portion,
          unit:            removed?.unit,
          quantity:        removed?.quantity,
          food_server_id:  removed?.food_server_id,
        },
        remaining_items_on_day: next.items.length,
      });
    }
  );
}
