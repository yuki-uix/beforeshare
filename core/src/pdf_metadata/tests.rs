use super::*;
use crate::{identity::sha256_hex, verification::Outcome};
use lopdf::{dictionary, Stream};
use std::{fs, num::NonZeroUsize};

fn document() -> Document {
    let mut doc = Document::with_version("1.4");
    doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
    let pages = doc.new_object_id();
    let content = doc.add_object(Stream::new(dictionary! {}, b"q Q".to_vec()));
    let page=doc.add_object(dictionary! { "Type"=>"Page", "Parent"=>pages, "MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()], "Contents"=>content });
    doc.objects.insert(
        pages,
        Object::Dictionary(dictionary! { "Type"=>"Pages", "Kids"=>vec![page.into()], "Count"=>1 }),
    );
    let root = doc.add_object(dictionary! { "Type"=>"Catalog", "Pages"=>pages });
    let mut info = lopdf::Dictionary::new();
    for field in Field::ALL {
        info.set(
            field.as_str(),
            Object::string_literal(format!("fictional-{}", field.as_str())),
        );
    }
    let info = doc.add_object(info);
    doc.trailer.set("Root", root);
    doc.trailer.set("Info", info);
    doc
}
fn encode(mut document: Document) -> Vec<u8> {
    let mut bytes = vec![];
    document.save_to(&mut bytes).unwrap();
    bytes
}
struct Fixture {
    dir: tempfile::TempDir,
    input: std::path::PathBuf,
    gate: Gate,
    registry: Registry,
    original: Vec<u8>,
}
impl Fixture {
    fn new(bytes: Vec<u8>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("metadata.pdf");
        fs::write(&input, &bytes).unwrap();
        let gate = Gate::new(&[dir.path()]).unwrap();
        Self {
            dir,
            input,
            gate,
            registry: Registry::new(NonZeroUsize::new(64).unwrap()),
            original: bytes,
        }
    }
    fn record(&mut self, id: &str) -> IntakeRecord {
        self.registry
            .intake(
                &self.gate,
                self.input.to_str().unwrap(),
                id,
                limits::defaults().input_bytes,
            )
            .unwrap()
    }
    fn plan(&mut self, id: &str, fields: &[Field]) -> Result<Plan, Error> {
        plan(self.record(id), fields, limits::defaults().input_bytes)
    }
    fn publish(&mut self, fields: &[Field]) -> PublishedRemoval {
        self.plan("run", fields)
            .unwrap()
            .approve(&mut self.registry, &self.gate)
            .unwrap()
            .publish(
                &mut self.registry,
                &self.gate,
                Destination::Automatic,
                &Cancellation::default(),
            )
            .unwrap()
    }
    fn assert_original(&self) {
        assert_eq!(fs::read(&self.input).unwrap(), self.original);
    }
    fn assert_only_original(&self) {
        self.assert_original();
        assert_eq!(fs::read_dir(self.dir.path()).unwrap().count(), 1);
    }
}
fn info(doc: &Document) -> &lopdf::Dictionary {
    doc.get_dictionary(doc.trailer.get(b"Info").unwrap().as_reference().unwrap())
        .unwrap()
}
fn refused<T: std::fmt::Debug>(result: Result<T, Error>, reason: Refusal) {
    assert!(
        matches!(result,Err(Error::Refused(actual)) if actual==reason),
        "expected {reason:?}, got {result:?}"
    );
}

#[test]
fn every_selected_field_is_removed_without_changing_other_fields_or_page_content() {
    for field in Field::ALL {
        let original = document();
        let before = info(&original).clone();
        let mut f = Fixture::new(encode(original));
        let plan = f.plan("run", &[*field]).unwrap();
        assert_eq!(plan.fields(), &[*field]);
        assert_eq!(plan.side_effects(), &[SideEffect::AltersVisualRendering]);
        assert_eq!(plan.side_effects()[0].as_str(), "alters_visual_rendering");
        assert!(!plan.side_effect_detail().contains("fictional"));
        let approved = plan.approve(&mut f.registry, &f.gate).unwrap();
        assert_eq!(approved.fields(), &[*field]);
        let published = approved
            .publish(
                &mut f.registry,
                &f.gate,
                Destination::Automatic,
                &Cancellation::default(),
            )
            .unwrap();
        assert_eq!(published.fields(), &[*field]);
        let after = Document::load_mem(&fs::read(published.path()).unwrap()).unwrap();
        assert!(!info(&after).has(field.as_str().as_bytes()));
        for other in Field::ALL.iter().filter(|other| *other != field) {
            assert_eq!(
                info(&after).get(other.as_str().as_bytes()).unwrap(),
                before.get(other.as_str().as_bytes()).unwrap()
            );
        }
        assert_eq!(after.get_pages().len(), 1);
        let page = *after.get_pages().values().next().unwrap();
        let before_document = Document::load_mem(&f.original).unwrap();
        let before_page = *before_document.get_pages().values().next().unwrap();
        assert_eq!(
            after.get_page_content_with_limit(page, 1 << 20).unwrap(),
            before_document
                .get_page_content_with_limit(before_page, 1 << 20)
                .unwrap()
        );
        assert_eq!(
            after
                .get_dictionary(page)
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap(),
            &vec![0.into(), 0.into(), 612.into(), 792.into()]
        );
        assert!(published.output().cleanup_complete());
        f.assert_original();
    }
}

#[test]
fn clearing_all_fields_removes_the_info_dictionary_and_orphaned_value_objects() {
    let mut doc = document();
    let author = doc.add_object(Object::string_literal("orphan-author-secret"));
    let id = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
    doc.get_dictionary_mut(id).unwrap().set("Author", author);
    let orphan = doc.add_object(Object::string_literal("unreachable-old-metadata-secret"));
    let mut f = Fixture::new(encode(doc));
    let planned = f.plan("run", Field::ALL).unwrap();
    assert_eq!(
        planned.side_effects(),
        &[
            SideEffect::AltersVisualRendering,
            SideEffect::MakesFutureEditingHarder
        ]
    );
    assert!(planned
        .side_effect_detail()
        .contains("pre-existing unreferenced objects"));
    let published = planned
        .approve(&mut f.registry, &f.gate)
        .unwrap()
        .publish(
            &mut f.registry,
            &f.gate,
            Destination::Automatic,
            &Cancellation::default(),
        )
        .unwrap();
    let bytes = fs::read(published.path()).unwrap();
    let after = Document::load_mem(&bytes).unwrap();
    assert!(!after.trailer.has(b"Info"));
    assert!(!after.objects.contains_key(&id));
    assert!(!after.objects.contains_key(&author));
    assert!(!after.objects.contains_key(&orphan));
    assert!(!String::from_utf8_lossy(&bytes).contains("orphan-author-secret"));
    assert!(!String::from_utf8_lossy(&bytes).contains("unreachable-old-metadata-secret"));
    assert!(!published
        .verify(&f.registry, &f.gate)
        .unwrap()
        .is_successful());
    f.assert_original();
}

#[test]
fn shared_values_remain_when_an_unapproved_field_still_references_them() {
    let mut doc = document();
    let value = doc.add_object(Object::string_literal("shared-secret"));
    let id = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
    let dict = doc.get_dictionary_mut(id).unwrap();
    dict.set("Author", value);
    dict.set("Title", value);
    let mut f = Fixture::new(encode(doc));
    let published = f.publish(&[Field::Author]);
    let after = Document::load_mem(&fs::read(published.path()).unwrap()).unwrap();
    assert!(!info(&after).has(b"Author"));
    assert!(after.objects.contains_key(&value));
    assert_eq!(
        info(&after).get(b"Title").unwrap(),
        &Object::Reference(value)
    );
    assert_eq!(
        published.verify(&f.registry, &f.gate).unwrap().outcome(),
        Outcome::UnableToVerify
    );
    f.assert_original();
}

#[test]
fn unicode_and_escaped_metadata_are_removed_as_fields_not_byte_substitutions() {
    let mut doc = document();
    let id = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
    doc.get_dictionary_mut(id).unwrap().set(
        "Author",
        Object::String(
            vec![0xfe, 0xff, 0x4f, 0x5c, 0x80, 0x05],
            lopdf::StringFormat::Hexadecimal,
        ),
    );
    doc.get_dictionary_mut(id).unwrap().set(
        "Title",
        Object::string_literal("keep (parentheses) and \\ slash"),
    );
    let mut f = Fixture::new(encode(doc));
    let published = f.publish(&[Field::Author]);
    let after = Document::load_mem(&fs::read(published.path()).unwrap()).unwrap();
    assert!(!info(&after).has(b"Author"));
    assert_eq!(
        info(&after).get(b"Title").unwrap().as_str().unwrap(),
        b"keep (parentheses) and \\ slash"
    );
    f.assert_original();
}

#[test]
fn malformed_ambiguous_signed_encrypted_and_xmp_inputs_fail_before_approval() {
    for variant in [
        "signature",
        "nested_signature",
        "byte_range",
        "permissions",
        "encryption",
        "xmp",
        "missing",
        "non_string",
        "info_alias",
        "dangling",
        "reference_cycle",
    ] {
        let mut doc = document();
        let id = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        let expected = match variant {
            "signature" => {
                doc.add_object(dictionary! { "Type"=>"Sig" });
                Refusal::SignatureRequiresReview
            }
            "nested_signature" => {
                doc.add_object(dictionary! { "Nested"=>dictionary! { "FT"=>"Sig" } });
                Refusal::SignatureRequiresReview
            }
            "byte_range" => {
                doc.add_object(dictionary! { "ByteRange"=>vec![0.into(),1.into()] });
                Refusal::SignatureRequiresReview
            }
            "permissions" => {
                let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
                doc.get_dictionary_mut(root)
                    .unwrap()
                    .set("Perms", lopdf::Dictionary::new());
                Refusal::SignatureRequiresReview
            }
            "encryption" => {
                doc.trailer.set("Encrypt", Object::Null);
                Refusal::BlockedByEncryption
            }
            "xmp" => {
                doc.add_object(dictionary! { "Metadata"=>Object::string_literal("xmp") });
                Refusal::XmpNotSupported
            }
            "missing" => {
                doc.get_dictionary_mut(id).unwrap().remove(b"Author");
                Refusal::MissingField
            }
            "non_string" => {
                doc.get_dictionary_mut(id).unwrap().set("Author", 42);
                Refusal::UnsupportedProfile
            }
            "info_alias" => {
                doc.trailer.set("Alias", id);
                Refusal::AliasedInfoDictionary
            }
            "dangling" => {
                doc.get_dictionary_mut(id)
                    .unwrap()
                    .set("Author", Object::Reference((9999, 0)));
                Refusal::MalformedPdf
            }
            _ => {
                let value = doc.new_object_id();
                doc.objects.insert(value, Object::Reference(value));
                doc.get_dictionary_mut(id).unwrap().set("Author", value);
                Refusal::MalformedPdf
            }
        };
        let mut f = Fixture::new(encode(doc));
        refused(f.plan("run", &[Field::Author]), expected);
        f.assert_only_original();
    }
}

#[test]
fn missing_duplicate_empty_selections_and_invalid_budgets_are_not_silent_noops() {
    let mut f = Fixture::new(encode(document()));
    refused(f.plan("empty", &[]), Refusal::EmptySelection);
    refused(
        f.plan("duplicate", &[Field::Author, Field::Author]),
        Refusal::DuplicateField,
    );
    for (i, budget) in [0, u64::MAX].into_iter().enumerate() {
        refused(
            plan(f.record(&format!("budget-{i}")), &[Field::Author], budget),
            Refusal::InvalidBudget,
        );
    }
    let mut doc = document();
    doc.trailer.remove(b"Info");
    let mut f = Fixture::new(encode(doc));
    refused(f.plan("missing", &[Field::Author]), Refusal::MissingField);
    f.assert_only_original();
}

#[test]
fn output_limit_and_cancellation_never_publish_or_modify_the_original() {
    let mut f = Fixture::new(encode(document()));
    let plan = plan(f.record("budget"), &[Field::Author], 1).unwrap();
    let approved = plan.approve(&mut f.registry, &f.gate).unwrap();
    refused(
        approved.publish(
            &mut f.registry,
            &f.gate,
            Destination::Automatic,
            &Cancellation::default(),
        ),
        Refusal::OutputTooLarge,
    );
    f.assert_only_original();
    let approved = f
        .plan("cancel", &[Field::Author])
        .unwrap()
        .approve(&mut f.registry, &f.gate)
        .unwrap();
    let cancel = Cancellation::default();
    cancel.cancel();
    refused(
        approved.publish(&mut f.registry, &f.gate, Destination::Automatic, &cancel),
        Refusal::Cancelled,
    );
    f.assert_only_original();
}

#[test]
fn planning_and_approval_do_not_survive_input_changes_or_cross_registry_tokens() {
    for when in ["before_approve", "after_approve", "foreign"] {
        let mut f = Fixture::new(encode(document()));
        let plan = f.plan("run", &[Field::Author]).unwrap();
        if when == "before_approve" {
            fs::write(&f.input, b"changed").unwrap();
            assert!(matches!(
                plan.approve(&mut f.registry, &f.gate),
                Err(Error::Identity(_))
            ));
        } else if when == "foreign" {
            let mut other = Registry::new(NonZeroUsize::new(1).unwrap());
            assert!(matches!(
                plan.approve(&mut other, &f.gate),
                Err(Error::Identity(_))
            ));
        } else {
            let approved = plan.approve(&mut f.registry, &f.gate).unwrap();
            fs::write(&f.input, b"changed").unwrap();
            assert!(matches!(
                approved.publish(
                    &mut f.registry,
                    &f.gate,
                    Destination::Automatic,
                    &Cancellation::default()
                ),
                Err(Error::Identity(_))
            ));
        }
        assert_eq!(fs::read_dir(f.dir.path()).unwrap().count(), 1);
    }
}

#[test]
fn output_identity_is_checked_before_any_readback_claim() {
    let mut f = Fixture::new(encode(document()));
    let published = f.publish(&[Field::Author]);
    let bytes = fs::read(published.path()).unwrap();
    assert_eq!(sha256_hex(&bytes), published.output().prepared().sha256());
    fs::write(published.path(), encode(document())).unwrap();
    assert!(matches!(
        published.verify(&f.registry, &f.gate),
        Err(Error::Identity(_))
    ));
    f.assert_original();
}

#[test]
fn same_parser_readback_never_counts_as_independently_verified_removal() {
    let mut f = Fixture::new(encode(document()));
    let published = f.publish(&[Field::Author]);
    let result = published.verify(&f.registry, &f.gate).unwrap();
    assert_eq!(result.outcome(), Outcome::UnableToVerify);
    assert!(!result.is_successful());
    assert_eq!(
        result.unverifiable_reason(),
        Some("no_independent_reader_for_this_action")
    );
    let json = serde_json::to_value(result).unwrap();
    assert!(json["surfacesChecked"].as_array().unwrap().is_empty());
    assert_eq!(json["readPaths"][0]["role"], "shares_writer_implementation");
    assert!(json["readPaths"][0].get("surface").is_none());
    assert!(!serde_json::to_string(&json).unwrap().contains("fictional"));
    fs::remove_file(published.path()).unwrap();
    let result = published.verify(&f.registry, &f.gate).unwrap();
    assert_eq!(result.outcome(), Outcome::UnableToVerify);
    assert_eq!(
        result.unverifiable_reason(),
        Some("output_could_not_be_reopened")
    );
}

#[test]
fn malformed_profile_boundaries_do_not_turn_into_successful_rewrites() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../");
    for name in [
        "xref-offsets-off-by-one.pdf",
        "no-xref-table.pdf",
        "stream-length-lies.pdf",
        "dangling-reference.pdf",
        "truncated.pdf",
        "deeply-nested-array.pdf",
    ] {
        let bytes = fs::read(root.join("experiments/malformed").join(name)).unwrap();
        let mut f = Fixture::new(bytes);
        assert!(f.plan("run", &[Field::Author]).is_err(), "{name}");
        f.assert_only_original();
    }
    for name in [
        "incremental-update.positive.pdf",
        "digital-signature.positive.pdf",
    ] {
        let mut f = Fixture::new(fs::read(root.join("fixtures/pdf/files").join(name)).unwrap());
        assert!(f.plan("run", &[Field::Author]).is_err(), "{name}");
        f.assert_only_original();
    }
}

#[test]
fn bounded_object_walk_refuses_deep_and_excessive_work() {
    let mut doc = document();
    let mut object = Object::Null;
    for _ in 0..pdf::graph_depth() + 1 {
        object = Object::Array(vec![object]);
    }
    doc.add_object(object);
    refused(scan(&doc), Refusal::ResourceLimitExceeded);
    let mut doc = document();
    doc.add_object(Object::Array(vec![Object::Null; pdf::graph_nodes()]));
    refused(scan(&doc), Refusal::ResourceLimitExceeded);
    let mut doc = document();
    doc.max_id = u32::MAX;
    refused(scan(&doc), Refusal::ResourceLimitExceeded);
}

#[test]
fn chained_info_aliases_are_not_mistaken_for_an_exclusive_metadata_dictionary() {
    let mut doc = document();
    let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
    let alias = doc.add_object(Object::Reference(info));
    doc.trailer.set("Info", alias);
    doc.trailer.set("OtherUse", info);
    let mut f = Fixture::new(encode(doc));
    refused(f.plan("run", &[Field::Author]), Refusal::UnsupportedProfile);
    f.assert_only_original();
}

#[test]
fn cross_reference_streams_and_nonstandard_info_containers_are_explicitly_unsupported() {
    let mut doc = document();
    doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceStream;
    let mut f = Fixture::new(encode(doc));
    refused(
        f.plan("stream", &[Field::Author]),
        Refusal::UnsupportedProfile,
    );
    f.assert_only_original();
    let mut doc = document();
    doc.trailer.set("Info", info(&doc).clone());
    let mut f = Fixture::new(encode(doc));
    refused(
        f.plan("direct", &[Field::Author]),
        Refusal::UnsupportedProfile,
    );
    f.assert_only_original();
}

#[test]
fn verification_keeps_the_approved_output_budget_when_the_path_grows() {
    let mut f = Fixture::new(encode(document()));
    let limit = f.original.len() as u64 + 256;
    let planned = plan(f.record("run"), &[Field::Author], limit).unwrap();
    let published = planned
        .approve(&mut f.registry, &f.gate)
        .unwrap()
        .publish(
            &mut f.registry,
            &f.gate,
            Destination::Automatic,
            &Cancellation::default(),
        )
        .unwrap();
    fs::write(published.path(), vec![b'x'; limit as usize + 1]).unwrap();
    let result = published.verify(&f.registry, &f.gate).unwrap();
    assert_eq!(result.outcome(), Outcome::UnableToVerify);
    assert_eq!(
        result.unverifiable_reason(),
        Some("output_could_not_be_reopened")
    );
    f.assert_original();
}

#[test]
fn reserved_objects_omitted_by_the_writer_are_rejected_before_approval() {
    for name in ["ObjStm", "XRef", "Linearized"] {
        let mut doc = document();
        let special = doc.add_object(dictionary! { "Type"=>name });
        let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(info)
            .unwrap()
            .set("CustomReference", special);
        let mut f = Fixture::new(encode(doc));
        // The fixture writer itself omits these objects. Exercise the parsed
        // object guard directly too, so the rejection isn't just its dangling ref.
        let mut original = document();
        original.add_object(dictionary! { "Type"=>name });
        refused(scan(&original), Refusal::UnsupportedProfile);
        assert!(f.plan("run", &[Field::Author]).is_err());
        f.assert_only_original();
    }
}
