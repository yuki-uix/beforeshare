use beforeshare_core::pdf_metadata::{ApprovedRemoval,Field};
fn change(approved:&ApprovedRemoval) { approved.fields()[0] = Field::Title; }
fn main() {}
