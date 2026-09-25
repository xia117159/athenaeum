use super::DirectorySizeService;
use crate::domain::directory_sizes::*;

#[test]
fn size_views_service_fences_reopened_windows_and_freezes_final_manifests() {
    let service = DirectorySizeService::default(); service.open_owner("main");
    let owner = service.owner_token("main").unwrap();
    let request = |epoch, revision, path: &str, nonce| UpdateDirectorySizeViewsRequest {
        revision, owner_epoch: Some(epoch), shutdown_nonce: nonce,
        scopes: vec![DirectorySizeViewScope { path: path.into(), priority: 0 }],
    };
    service.update_views(owner.clone(), request(owner.epoch.to_string(), 1, "C:\\old", None)).unwrap();
    service.open_owner("main");
    assert!(service.update_views(owner.clone(), request(owner.epoch.to_string(), 2, "C:\\late", None)).is_err());
    let owner = service.owner_token("main").unwrap();
    service.update_views(owner.clone(), request(owner.epoch.to_string(), 1, "D:\\new", None)).unwrap();
    let notices = service.collect_views("nonce".into());
    assert_eq!(notices.len(), 1); assert!(!service.views_collected());
    service.update_views(owner.clone(), request(owner.epoch.to_string(), 2, "E:\\final", Some("nonce".into()))).unwrap();
    assert!(service.views_collected());
    service.close_owner("main");
    let frozen = service.freeze_views();
    assert_eq!(service.freeze_views(), frozen);
    assert!(frozen[0].path.ends_with("final"));
}
