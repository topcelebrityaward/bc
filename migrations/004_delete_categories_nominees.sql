-- Top Celebrities Award (TCA) — delete categories/nominees
-- Run in the Supabase SQL editor.
--
-- WARNING: this permanently deletes votes and transaction records tied to
-- these nominees. If any of them received real paid votes, that revenue/
-- audit history is gone after this runs — there is no undo.
--
-- RECOMMENDED FIRST STEP: run this to see exactly what will be affected
-- before deleting anything:

select c.name as category, n.full_name as nominee, count(v.id) as vote_count
from nominees n
join categories c on c.id = n.category_id
left join votes v on v.nominee_id = n.id
where c.name in ('Best Kalenjin Artist', 'Best Humanitarian Honors', 'Best Female Artist', 'Best Radio Presenter')
   or n.full_name in ('Daisy Sentayo', 'Allan Ke', 'Isaac Waihenya', 'Vivian Kenya')
group by c.name, n.full_name;

-- ----------------------------------------------------------------
-- Once you've checked the above and are sure, run the block below.
-- ----------------------------------------------------------------

begin;

-- 1. Delete the four named categories (and every nominee inside them)

delete from votes where nominee_id in (
  select n.id from nominees n
  join categories c on c.id = n.category_id
  where c.name in ('Best Kalenjin Artist', 'Best Humanitarian Honors', 'Best Female Artist', 'Best Radio Presenter')
);

delete from transactions where nominee_id in (
  select n.id from nominees n
  join categories c on c.id = n.category_id
  where c.name in ('Best Kalenjin Artist', 'Best Humanitarian Honors', 'Best Female Artist', 'Best Radio Presenter')
);

-- Nominees, sponsorships, and nomination_applications for these categories
-- all cascade-delete automatically once the category itself is deleted.
delete from categories
where name in ('Best Kalenjin Artist', 'Best Humanitarian Honors', 'Best Female Artist', 'Best Radio Presenter');

-- 2. Delete the four named nominees individually (from whichever category
--    they're in, if their category wasn't already deleted above)

delete from votes where nominee_id in (
  select id from nominees where full_name in ('Daisy Sentayo', 'Allan Ke', 'Isaac Waihenya', 'Vivian Kenya')
);

delete from transactions where nominee_id in (
  select id from nominees where full_name in ('Daisy Sentayo', 'Allan Ke', 'Isaac Waihenya', 'Vivian Kenya')
);

delete from nominees
where full_name in ('Daisy Sentayo', 'Allan Ke', 'Isaac Waihenya', 'Vivian Kenya');

commit;

-- ----------------------------------------------------------------
-- SAFER ALTERNATIVE, if you'd rather not lose vote/payment history:
-- deactivate instead of delete. This hides them from the public site
-- while keeping all records intact.
-- ----------------------------------------------------------------
-- update categories set is_active = false
--   where name in ('Best Kalenjin Artist', 'Best Humanitarian Honors', 'Best Female Artist', 'Best Radio Presenter');
--
-- update nominees set is_active = false
--   where full_name in ('Daisy Sentayo', 'Allan Ke', 'Isaac Waihenya', 'Vivian Kenya');
