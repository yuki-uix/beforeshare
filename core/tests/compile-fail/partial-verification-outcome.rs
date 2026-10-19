use beforeshare_core::verification::Outcome;
fn success(outcome:Outcome)->bool {
    match outcome { Outcome::VerifiedRemoved | Outcome::VerifiedTransformed => true }
}
fn main() {}
