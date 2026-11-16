//! Kiểm thử SqliteSecretStore: CRUD, khóa xấu, liệt kê theo tiền tố, bền qua lần mở lại, nhập file cũ.
use openclaw_personal_core::secrets::{SecretError, SecretStore};
use openclaw_personal_core::sqlite_store::SqliteSecretStore;

#[tokio::test]
async fn crud_va_khoa_xau() {
    let d = tempfile::tempdir().unwrap();
    let s = SqliteSecretStore::open(d.path()).unwrap();
    assert_eq!(s.get("k").await.unwrap(), None);
    s.set("k", "một").await.unwrap();
    s.set("k", "hai").await.unwrap();
    assert_eq!(s.get("k").await.unwrap().as_deref(), Some("hai"));
    s.delete("k").await.unwrap();
    s.delete("k").await.unwrap();
    assert_eq!(s.get("k").await.unwrap(), None);
    for k in ["../x", "a/b", ".x", ""] {
        assert!(matches!(s.set(k, "v").await, Err(SecretError::InvalidKey)));
    }
}

#[tokio::test]
async fn list_theo_tien_to_va_ben_qua_lan_mo_lai() {
    let d = tempfile::tempdir().unwrap();
    {
        let s = SqliteSecretStore::open(d.path()).unwrap();
        for k in ["gmail-b", "gmail-a", "gmail_x", "messenger-1"] {
            s.set(k, "v").await.unwrap();
        }
    }
    let s = SqliteSecretStore::open(d.path()).unwrap();
    assert_eq!(s.list("gmail-").await.unwrap(), vec!["gmail-a", "gmail-b"]);
    assert_eq!(s.list("").await.unwrap().len(), 4);
}

#[tokio::test]
async fn nhap_file_cu_roi_xoa() {
    let d = tempfile::tempdir().unwrap();
    let old = d.path().join("secrets");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("gmail-index"), "[1]").unwrap();
    std::fs::write(old.join(".x.tmp"), "rác").unwrap();
    let s = SqliteSecretStore::open(d.path()).unwrap();
    assert_eq!(s.get("gmail-index").await.unwrap().as_deref(), Some("[1]"));
    assert!(!old.join("gmail-index").exists());
}

#[tokio::test]
async fn ghi_dong_thoi_khong_mat_du_lieu() {
    let d = tempfile::tempdir().unwrap();
    let s = std::sync::Arc::new(SqliteSecretStore::open(d.path()).unwrap());
    let hs: Vec<_> = (0..20).map(|i| { let s = s.clone(); tokio::spawn(async move { s.set(&format!("k{i}"), "v").await.unwrap() }) }).collect();
    for h in hs { h.await.unwrap(); }
    assert_eq!(s.list("k").await.unwrap().len(), 20);
}
