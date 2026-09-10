    # V3 — Thay kiến trúc Theme Map và render

    Ngày cập nhật: 05/09/2026. Bản nền: V3 rebuilt. Kiến trúc thay thế lấy từ `ai-search.rar` được cung cấp.

    ## Luồng hiện tại

    1. Đọc theme đang publish bằng Admin API.
    2. Bắt đầu ở `templates/search.json`, hoặc `templates/search.liquid` nếu không có JSON. Đọc các section và dependency được template gọi.
    3. Tạo Theme Map, lưu trong app-installation metafield `ai_search.theme_map_<numeric-theme-id>`. Không lưu toàn bộ mã nguồn theme trong map.
    4. App Embed dùng Theme Map để xác định phạm vi trang search. Khi tìm kiếm, runtime kiểm tra lại map với backend trước khi dùng AI.
    5. Proxy xác thực shop, kiểm tra loại truy vấn, gói/quota, dữ liệu và theme. Sau đó tạo embedding, tìm Qdrant theo shop và kiểm tra lại sản phẩm trực tiếp từ Shopify.
    6. Proxy trả JSON gồm ID, handle theo thứ tự AI, Theme ID và fingerprint của map. Proxy không tạo Liquid hoặc gọi snippet sản phẩm.
    7. Runtime gọi search gốc của Shopify với các ID. Shopify dùng toàn bộ ngữ cảnh theme hiện tại để tạo HTML.
    8. Runtime lấy các thẻ sản phẩm đã render, kiểm tra handle và xếp theo thứ tự AI. Nếu Shopify chia thành nhiều trang, runtime lấy thêm trang trong cùng tập kết quả; không gọi AI thêm cho mỗi trang HTML.
    9. Nếu thiếu sản phẩm, không tìm được grid, theme thay đổi hoặc có lỗi, chuyển sang truy vấn search gốc với dấu bypass để tránh lặp.

    ## Những phần đã thay

    | Phần | Trước | Hiện tại |
    | --- | --- | --- |
    | Bắt theme | Tìm và chấm điểm renderer/snippet | Theme Map từ search template theo kiến trúc ai-search |
    | Backend | Sinh Liquid bằng Theme Compiler/Renderer Bridge | Trả JSON danh sách sản phẩm |
    | Render | App Proxy gọi snippet ngoài section gốc | Shopify render `/search` trong ngữ cảnh theme |
    | Storefront | Chuyển hướng sang trang Liquid proxy | Runtime nhận HTML của theme rồi cập nhật grid |
    | Map lưu bền | Không có | App metafield riêng theo numeric Theme ID |
    | Dashboard | Báo renderer tương thích | Báo trạng thái đồng bộ map và nút đọc lại |

    Đã bỏ `theme-compiler.server.ts`, `theme-renderer-profile.server.ts`, `renderer-bridge.server.ts`, resolver tham số renderer và asset điều hướng cũ. Giữ handle App Embed `ai_search_bridge` và extension identity của V3 để không tự tạo thêm một extension trùng.

    Các phần Qdrant theo shop, `publishedAt`, webhook sản phẩm, hàng đợi/retry, gói, quota và thống kê tiếp tục dùng V3.

    ## Điều chỉnh khi ghép bản ai-search

    - Runtime đọc `schema.search`, đúng cấu trúc map được tạo; dùng section IDs trong map để thu hẹp vùng tìm grid. Các selector/fallback của runtime ai-search vẫn tồn tại, không còn tuyên bố đây là cơ chế hoàn toàn không dùng DOM selector.
    - Key metafield dùng ID dạng số; giữ GraphQL GID ở trường riêng. Ghi có `compareDigest` để phát hiện cập nhật đồng thời. [Shopify metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet)
    - Đọc dependency theo từng nhóm tối đa 50 file, hỗ trợ dấu `-%}`, `include`, khối `liquid`, comment JSON và section bị tắt. Không giới hạn ở 250 file đầu toàn theme như bản gửi.
    - Kiểm tra nội dung các dependency khi dùng map cũ; không phụ thuộc duy nhất vào `theme.updatedAt` hoặc webhook. Shopify lưu ý `themes/update` không được phát cho mọi lần sửa file. [Webhook topics](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic)
    - Backend và runtime đối chiếu Theme ID/map trước khi dùng kết quả. Sau khi gọi AI, backend kiểm tra lại theme, embed và map.
    - Giữ đường dẫn search có locale qua `routes.search_url`, giữ loại tìm kiếm và tham số native; không chặn Theme Editor hoặc preview được nhận diện.
    - Có xử lý native search không có grid vì không tìm thấy kết quả: dùng section HTML do theme trả về. Có hủy request cũ và giới hạn thời gian 30 giây ở runtime.
    - Kết quả AI vẫn giới hạn theo entitlement V3, tối đa 20 sản phẩm. Bản này không mở rộng lên 1.000 sản phẩm hoặc dùng page size 2 của bản ai-search.

    ## Nâng cấp trên dev store

    1. Giải nén vào thư mục làm việc mới. Dùng lại cấu hình ứng dụng và biến môi trường của V3; không thay API key hoặc Qdrant collection bằng dữ liệu từ bản đồng nghiệp.
    2. Dùng Node >=22.18; chạy `npm ci`, `npm run setup`, `npm run dev`. Prisma/migrations trong gói hiện tại là SQLite, không phải migration MySQL.
    3. Triển khai cả backend và Theme App Extension cùng phiên bản. Asset mới là `search-interceptor.v3.js`; không giữ asset cũ trong bản triển khai.
    4. Mở dashboard, đọc lại Theme Map. Mở Theme Editor của theme đang publish, xác nhận App Embed AI Search Bridge được bật rồi Save. App không tự ghi file hoặc bật embed của merchant.
    5. Khi publish theme khác, map được làm mới ở lần kiểm tra dashboard/storefront tiếp theo. Theme mới phải có embed được bật; trạng thái bật của theme cũ không được coi là trạng thái của theme mới.
    6. Có thể đặt `AI_SEARCH_APP_EMBED_EXTENSION_ID` bằng phần ID cuối của type `shopify://apps/.../blocks/ai_search_bridge/<id>` để phân biệt chính xác với app khác có cùng block handle.

    ## Phạm vi kiểm tra và điểm còn cần xác nhận

    `npm run typecheck`, `npm run lint`, `npm run test:v3`, `npm run build` đã chạy đạt ở môi trường Node 24.19.0.

    Bộ test trình duyệt có 9 ca trong `scripts/storefront-selftest.cjs`: grid thường, native không có kết quả, custom element, thiếu sản phẩm ở HTML, theme thay đổi, backend lỗi, SKU, mixed search và Theme Editor. **Chưa có kết quả chạy đạt cho bộ test này:** môi trường thiếu Chromium; trình duyệt đám mây chặn URL fixture nội bộ theo chính sách. Không coi kiểm tra TypeScript hoặc mock backend là bằng chứng đã render thành công trên Shopify.

    Để chạy tại máy có Chromium: cài Playwright phục vụ kiểm thử, chạy `npx playwright install chromium` rồi `npm run test:storefront`. Bộ test mock backend/native HTML; sau đó vẫn cần thử dev store thật.

    Các điểm bắt buộc xác nhận trên storefront thật:

    - Search theo biểu thức `id:... OR id:...` của bản ai-search có trả đúng sản phẩm ở cửa hàng này hay không. Runtime kiểm tra handle để không nhận nhầm kết quả; không coi cách này là API xếp hạng tùy ý được Shopify bảo đảm.
    - Theme hiện dùng có grid phù hợp với cách nhận diện của runtime hay không; quick add, variant picker, app block và script khởi tạo riêng của theme có hoạt động sau cập nhật DOM hay không.
    - Đổi A → B → A, sửa section của cùng theme, tắt embed khi query đang chạy, và đường dẫn locale.
    - Thống kê tìm kiếm được chốt khi backend trả ranking hợp lệ. Nếu trình duyệt thất bại sau phản hồi JSON, bản này chưa có giao thức xác nhận render để hoàn quota tự động. Embedding thực sự đã tạo vẫn được ghi nhận.

    Bản này là mã nguồn V3 đã thay kiến trúc theo yêu cầu; chưa chứng nhận tương thích mọi theme hoặc sẵn sàng production sau kiểm thử storefront.
