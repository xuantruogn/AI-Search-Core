# AI-Buyense User Billing Statuses

These are business-facing states, not Shopify enum values.

| ID | User-facing status | Meaning | Typical access |
|---|---|---|---|
| U01 | Chưa đăng ký gói | No active subscription | Free/basic access |
| U02 | Đang chờ xác nhận thanh toán | Charge created, awaiting approval | No paid access |
| U03 | Đang dùng thử | Active subscription within trial | Paid features |
| U04 | Đang dùng thử — đã tắt gia hạn | Trial active but cancellation/non-renewal scheduled | Paid features until trial end |
| U05 | Đang sử dụng — thanh toán/gia hạn tự động | Active paid subscription with no scheduled cancellation | Paid features |
| U06 | Đang sử dụng — đã tắt gia hạn | Active subscription scheduled to end | Paid features until current period end |
| U07 | Thanh toán thất bại — cần xử lý | Billing/payment problem requires action | Policy-dependent |
| U08 | Tạm dừng do vấn đề thanh toán | Shopify subscription is frozen | Policy-dependent |
| U09 | Thanh toán đã khôi phục | Billing problem recovered | Restore according to Shopify active state |
| U10 | Đã hủy gói | Subscription canceled | According to cancellation effective time |
| U11 | Gói đã hết hạn | Subscription ended/expired | No paid access |
| U12 | Thanh toán/gói bị từ chối | Merchant declined charge | No paid access |
| U13 | Đang chuyển gói | New plan approval/replacement is in progress | Keep existing access until replacement rules resolve |
| U14 | Đã chuyển sang gói mới | Replacement completed and new plan active | New plan access |
| U15 | Ứng dụng đã bị gỡ | App uninstalled | No app access |

## Important

U01-U15 are not one-to-one mappings to Shopify statuses. The backend should derive them from the current Shopify subscription plus local lifecycle/event history.
