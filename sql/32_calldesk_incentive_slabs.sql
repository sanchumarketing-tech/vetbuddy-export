-- Call Desk incentive amounts (20 Nov 2026) - already applied to the live database.
-- Amount = fixed amount at the highest slab reached + per_visit x (eligible visits - slab start). Below the first slab: 0.
-- Eligible visits = Incentives page rule (booked by the agent's login, billed on the appointment date or up to 3 days after, not shared).
-- Sources: "Final Agent Incentive Plan" (Incoming Calls = Inbound; Social Media / Sharp Shooting / Runo / Appointment Confirmation / VOW)
--          "Backend Team - Call Center | Chat Process Incentive Policy" (Chat: marginal slabs from 250).
-- Not included yet: attendance bonus (Rs 500), chat bonuses (zero open messages Rs 500, response TAT Rs 500).
-- To change a rate: update calldesk.incentive_slabs set per_visit = ... where department = ... and from_visits = ...;

create table if not exists calldesk.incentive_slabs (
  department text not null references calldesk.departments (name) on update cascade on delete cascade,
  from_visits int not null, fixed_amount numeric not null, per_visit numeric not null,
  primary key (department, from_visits));
alter table calldesk.incentive_slabs enable row level security;
insert into calldesk.incentive_slabs (department, from_visits, fixed_amount, per_visit) values
  ('Sharpshooting', 100, 500, 10), ('Sharpshooting', 150, 1000, 20), ('Sharpshooting', 200, 2000, 30), ('Sharpshooting', 250, 3500, 40), ('Sharpshooting', 300, 5500, 50),
  ('Social Media', 100, 500, 10), ('Social Media', 150, 1000, 20), ('Social Media', 200, 2000, 30), ('Social Media', 250, 3500, 40), ('Social Media', 300, 5500, 50),
  ('Inbound', 250, 500, 10), ('Inbound', 300, 1000, 20), ('Inbound', 350, 2000, 30), ('Inbound', 400, 3500, 40),
  ('Chat', 250, 0, 10), ('Chat', 300, 500, 25), ('Chat', 400, 3000, 35), ('Chat', 500, 6500, 50), ('Chat', 600, 11500, 60)
on conflict do nothing;
-- functions calldesk.incentive_amount / calldesk.incentive_next and the cd_incentives changes: see sql/live/.
-- Vaccine chart (same day): build_list "vaccine_course" now follows the chart - see sql/live/calldesk.build_list.sql.
