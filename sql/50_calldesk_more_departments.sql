-- 50  Call Desk: three more departments (27 Nov 2026). Listed in Agents; no call lists yet (calls = false),
--     like Inbound / Social Media / Chat, until their process is set up. Safe to run again.
insert into calldesk.departments (name, sort, calls) values
  ('VOW', 5, false), ('Runo Incoming', 6, false), ('Corefactor Incoming', 7, false)
on conflict (name) do nothing;
