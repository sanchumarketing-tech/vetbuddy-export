-- 24 Nov 2026: Vet on Wheels agents also call their parent clinic's customers for things that can be done at home.
-- calldesk.vow_parent          VOW unit -> clinic unit(s) (CH -> the 5 Chennai clinics, CBE -> Coimbatore, Madurai, Trichy)
-- calldesk.home_visit_reasons  reasons a home visit can serve (vaccines, deworming, senior check, review, follow-ups,
--                              post-surgery check, multi-pet, check-in, bath, haircut). Edit the table to change.
-- calldesk.home_ok(units, row unit, reasons)  true if a VOW agent may hold that clinic row
-- balance_lists: step 2c - VOW agents under target take unassigned parent-clinic rows with a home reason (after the
--   clinic agents had theirs); step 3 check-ins - clinic agents first, then VOW agents also get parent-clinic check-ins
--   labelled "Check-in (Vet on Wheels) ... offer a home visit".
-- rebalance_today: such rows are not released from a VOW agent.
-- Live definitions: sql/live/calldesk.balance_lists.sql, calldesk.rebalance_today.sql, calldesk.home_ok.sql
create table if not exists calldesk.vow_parent (vow_unit text not null, clinic_unit text not null, primary key (vow_unit, clinic_unit));
insert into calldesk.vow_parent values ('CH VET ON WHEELS','ADYAR'),('CH VET ON WHEELS','ANNA NAGAR'),('CH VET ON WHEELS','VELACHERY'),
 ('CH VET ON WHEELS','NEELANGARAI'),('CH VET ON WHEELS','VALASARAVAKKAM'),('CBE VET ON WHEELS','COIMBATORE'),
 ('MADURAI VET ON WHEELS','MADURAI'),('TRICHY VET ON WHEELS','TRICHY') on conflict do nothing;
create table if not exists calldesk.home_visit_reasons (type text primary key, note text);
insert into calldesk.home_visit_reasons values
 ('vaccine_due','vaccination at home'),('vaccine_course','next vaccine dose at home'),('rabies_course','anti-rabies dose at home'),
 ('vaccine_never','vaccination at home'),('sibling_vaccine','vaccination at home'),('deworm_due','deworming at home'),
 ('senior_check','senior check-up at home'),('tick_recheck','review / re-test at home'),('review_due','review at home'),
 ('consult_followup','follow-up at home'),('post_surgery','post-surgery check at home'),('multi_pet','all pets at home in one visit'),
 ('checkin','check-in, offer a home visit'),('bath_due','bath at home'),('haircut_due','haircut at home')
 on conflict do nothing;
