# Cơ Chế Phát Hiện & Đình Chỉ Tài Khoản Của Google Khi Sử Dụng Tool Xoay Auth

> Tài liệu phân tích kỹ thuật chuyên sâu về hạ tầng chống lạm dụng của Google (GFE, Cloud Code API, Google Identity Risk Engine), các vector phát hiện khi proxy/xoay vòng tài khoản OAuth, và bộ quy tắc vận hành an toàn cho `atc`.

---

## 1. Bản Chất Vấn Đề: Token Arbitrage & Private API Proxying

Các công cụ như `atc`, `opencode-antigravity-auth`, hay làn sóng `OpenClaw` (tháng 2/2026) đều hoạt động dựa trên một nguyên lý chung: **tận dụng token OAuth của người dùng cuối để gọi vào các backend trợ giá (subsidized backend) của Google** (cụ thể là `daily-cloudcode-pa.googleapis.com` và `cloudcode-pa.googleapis.com` thuộc hệ sinh thái Antigravity / Gemini Code Assist).

### Góc nhìn từ hạ tầng của Google
* **Token Arbitrage**: Các gói thuê bao Google One AI Premium ($19.99/tháng) hoặc AI Ultra ($249.99/tháng) cung cấp hạn ngạch rất lớn cho lập trình viên sử dụng trên IDE chính thức (Antigravity IDE, VS Code Extension). Chi phí thực tế của việc suy luận các mô hình flagship (Gemini 3.8, Gemini 4 Argon, Claude 3.7 Sonnet passthrough) cao hơn nhiều so với giá thuê bao người dùng trả, do được trợ giá để mở rộng thị phần nhà phát triển.
* **Degradation of Service**: Khi các công cụ proxy bên thứ ba kết nối với các agent tự hành (Claude Code CLI, OpenClaw, Roo-Code) chạy vòng lặp vô tận, lưu lượng request tăng đột biến (burst traffic) làm quá tải cụm hạ tầng tính toán, gây suy giảm chất lượng dịch vụ của người dùng IDE thật.
* **Quan điểm thực thi ToS (Terms of Service)**: Google không cấm lập trình viên sử dụng AI, nhưng điều khoản của Antigravity/Cloud Code quy định rõ: *Không được sử dụng backend của Antigravity như một proxy trung gian để cung cấp tài nguyên cho các ứng dụng, môi trường hoặc sản phẩm bên thứ ba ngoài giao diện được cấp phép*.

---

## 2. Phân Loại 5 Cấp Độ Trừng Phạt (Enforcement Taxonomy)

Khi hệ thống quét của Google ghi nhận bất thường, hình phạt được áp dụng theo các cấp bậc leo thang:

```text
[MỨC ĐỘ NGUY HIỂM TĂNG DẦN]

┌────────────────────────────────────────────────────────┐
│ Cấp 1: Soft Rate-Limit (HTTP 429)                      │
│ -> RESOURCE_EXHAUSTED / quotaResetDelay                │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Cấp 2: Interactive Verification Challenge (HTTP 403)   │
│ -> VALIDATION_REQUIRED / Browser Check / Captcha       │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Cấp 3: Service-level ToS Suspension (HTTP 403)         │
│ -> Service Disabled on Antigravity / Cloud Code        │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Cấp 4: Google Cloud Managed Project Deletion           │
│ -> Project disabled / IAM service account revoked      │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Cấp 5: Full Google Account Disablement                 │
│ -> "Account is disabled" / Mất toàn bộ Gmail, Drive... │
└────────────────────────────────────────────────────────┘
```

### Chi tiết từng cấp độ

| Cấp độ | Mã phản hồi | Trạng thái kỹ thuật | Hậu quả thực tế & Cách xử lý |
| :--- | :--- | :--- | :--- |
| **1. Soft Rate-Limit** | HTTP 429 (`RESOURCE_EXHAUSTED`) | Vượt RPM/TPM hoặc cạn hạn ngạch trượt 5 giờ / hạn ngạch tuần. | **Hoàn toàn an toàn.** Tài khoản không bị gắn cờ tiêu cực. Chỉ cần chờ hết thời gian phạt (`quotaResetDelay` hoặc `quotaResetTimeStamp`) hoặc để load balancer chuyển sang tài khoản khác. |
| **2. Verification Challenge** | HTTP 403 (`VALIDATION_REQUIRED`) | Google nghi ngờ lưu lượng bot tự động, đóng băng API tạm thời và yêu cầu tương tác người dùng. | **Tài khoản chưa bị khóa.** Mở URL thử thách trong trình duyệt, đăng nhập thủ công, giải CAPTCHA hoặc xác minh SMS. Sau khi hoàn thành, token hoạt động trở lại. Tuyệt đối không để proxy tự động gửi lại request liên tục khi đang dính cờ này. |
| **3. Service-level ToS Suspension** | HTTP 403 (`PERMISSION_DENIED` - Service disabled for ToS violation) | Hệ thống phát hiện vi phạm ToS Antigravity (dùng qua wrapper, token sharing, xoay tài khoản quá đà). | **Khóa riêng dịch vụ AI Coding.** Tài khoản Google (Gmail, Drive, Photos, YouTube) vẫn hoạt động 100% bình thường. Chỉ có quyền gọi API Antigravity / Cloud Code bị tước vĩnh viễn hoặc phải gửi đơn kháng nghị (Appeal). |
| **4. Cloud Project Lock** | HTTP 403 / 400 (`PROJECT_DELETED` / `SUSPENDED`) | Dự án Google Cloud gán ngầm cho tài khoản bị hạ do vi phạm hạn mức tài nguyên nền tảng. | Toàn bộ các phiên gRPC liên kết với Project ID đó bị hủy. Cần làm mới hoặc onboard lại dự án nếu tài khoản chưa bị đình chỉ hoàn toàn. |
| **5. Full Account Disablement** | `invalid_grant` / Thông báo "Account is disabled" khi đăng nhập web | Vi phạm nghiêm trọng chính sách bảo mật & spam của Google (tạo tài khoản hàng loạt, dùng thẻ lậu, botnet). | **Mất toàn bộ tài khoản.** Mất quyền truy cập Gmail, Google Drive, dữ liệu cá nhân. Xảy ra khi cố tình farm hàng chục clone trên cùng một IP/thiết bị mà không có biện pháp cách ly danh tính. |

---

## 3. Các Vector Phát Hiện Kỹ Thuật (Detection Vectors)

Hạ tầng bảo vệ của Google kết hợp dữ liệu từ **Google Frontend (GFE)**, **Cloud Armor**, **Google Identity Risk Engine** và các mô hình học máy phân tích hành vi (Socrates/Bandicoot):

### 3.1. Tầng Mạng & Kết Nối (L4 - L7)

#### A. IP-to-Account Cardinality Anomaly (Mật độ tài khoản trên một IP)
* Một người dùng bình thường làm việc trên máy tính cá nhân chỉ duy trì từ 1 đến 2 tài khoản Google trên một địa chỉ IP mạng gia đình (Residential IP).
* Khi tool xoay account kích hoạt chiến lược đổi liên tục (như `round-robin`), cùng một địa chỉ IP công cộng gửi request liên tiếp cho 4–10 tài khoản Google khác nhau trong vòng vài phút. Tỷ lệ cardinality bất thường này là tín hiệu hàng đầu kích hoạt bộ lọc kiểm tra lạm dụng.

#### B. Socket Multiplexing & Connection Re-use (Tái sử dụng Socket)
* Nếu HTTP client dùng chung connection pool cho nhiều tài khoản (như mặc định của Node.js `undici/fetch` hay Python `requests.Session`), các request mang `Authorization: Bearer <Token_A>` và `Authorization: Bearer <Token_B>` sẽ được gửi trên **cùng một kết nối TCP/TLS keep-alive** tới GFE.
* GFE ghi nhận trực tiếp Socket ID ở tầng transport. Hai tài khoản hoàn toàn độc lập xuất hiện trên cùng một luồng TCP là bằng chứng tuyệt đối cho thấy cả hai đang chạy trong cùng một tiến trình proxy.

#### C. TLS Fingerprinting (JA3 / JA4)
* Native Antigravity binary được xây dựng bằng Go (sử dụng Go crypto/tls) hoặc Electron/Chromium stack.
* Khi proxy chạy bằng Node.js tiêu chuẩn, các thông số TLS ClientHello (danh sách Cipher Suites, thứ tự TLS Extensions, Supported Groups, Elliptic Curves) tạo ra một dấu vân tay JA3/JA4 đặc trưng của Node.js OpenSSL. Sự bất nhất giữa User-Agent (tự xưng là Antigravity Desktop) và dấu vân tay TLS là tín hiệu nhận diện tự động rất mạnh.

#### D. Wire Header Ordering & Casing
* Go HTTP client và trình duyệt gửi header theo casing chuẩn (`User-Agent`, `Content-Type`, `Authorization`).
* Nhiều HTTP library hiện đại tự động chuẩn hóa toàn bộ tên header về chữ thường (`user-agent`, `content-type`). GFE có khả năng kiểm tra thứ tự và cách viết hoa của header để phân loại client thật vs proxy giả lập.

---

### 3.2. Tầng Giao Thức & Telemetry (Cloud Code API)

#### A. Payload ClientMetadata
* API của Cloud Code yêu cầu cấu trúc `clientMetadata`:
  ```json
  {
    "clientMetadata": {
      "ideType": 9,
      "platform": 5,
      "pluginType": 2
    }
  }
  ```
  *(Trong đó: `ideType: 9` = Antigravity, `platform: 5` = Windows AMD64, `pluginType: 2` = Gemini).*
* Nếu khai báo `ideType: 9` nhưng thiếu các header telemetry song hành (`x-goog-api-client`, metadata dự án) hoặc không gửi kèm các ping trạng thái định kỳ của extension, backend sẽ ghi nhận phiên gọi là bất thường.

#### B. Trích Xuất & Giám Sát System Prompt
* Claude Code CLI inject các prompt chỉ dẫn đặc thù của Anthropic (`You are Claude Code`, các định nghĩa tool calls dạng Anthropic Schema, cấu trúc thinking block).
* Nếu proxy forward nguyên văn toàn bộ system prompt và tool definitions này lên endpoint Gemini của Google mà không làm sạch, hệ thống kiểm duyệt nội dung (Safety Filters / Audit Logging) của Google có thể dễ dàng nhận diện lưu lượng này bắt nguồn từ một công cụ AI đối thủ đang dùng hạ tầng của Google làm backend giá rẻ.

---

### 3.3. Tầng Hành Vi & Hạn Ngạch (Heuristics)

#### A. Request Interleaving (Xen kẽ ngữ cảnh giữa các tài khoản)
* Đây là tử huyệt của chiến lược **`round-robin`**.
* Trong một phiên làm việc của Claude Code:
  1. Prompt 1: "Hãy viết hàm đọc file" $\rightarrow$ Model phản hồi yêu cầu gọi tool $\rightarrow$ Dùng `Account A`.
  2. Prompt 2 (5 giây sau): Trả kết quả tool call cho model $\rightarrow$ Xoay sang `Account B`.
  3. Prompt 3 (10 giây sau): Sửa tiếp đoạn code $\rightarrow$ Xoay sang `Account C`.
* **Hậu quả**: Trên server Google, 3 người dùng hoàn toàn khác nhau lại gửi 3 request tiếp nối nhau hoàn hảo về mặt ngữ cảnh code, token count và logic hội thoại chỉ trong vài giây. Đây là hành vi không bao giờ xảy ra với người dùng thật.

#### B. Bẫy Chia Sẻ Hạn Ngạch Gia Đình (Family Group Quota Synchronization Trap)
* Người dùng mua gói Google One AI Pro/Ultra trên tài khoản chính, sau đó tạo 5 tài khoản con trong cùng Family Group (`families.google.com`) và nạp cả 5 tài khoản vào tool xoay với hy vọng nhân 5 lần hạn ngạch.
* **Cơ chế thực tế của Google**: Hạn ngạch Antigravity (cả 5-hour rolling limit và 7-day weekly cap) **được chia sẻ chung trên toàn bộ nhóm gia đình** (shared quota pool).
* **Hệ quả**: Khi một tài khoản con dùng hết quota, toàn bộ 4 tài khoản còn lại trong gia đình đồng loạt về 0%. Việc nạp cả 5 tài khoản vào tool không hề tăng thêm 1 token nào, nhưng lại tạo ra lưu lượng xoay vòng 5 tài khoản từ cùng một địa chỉ IP, kích hoạt cờ đỏ quét lạm dụng ngay lập tức.

#### C. Độ Tuổi Tài Khoản & Gia Tốc Lưu Lượng (Fresh Clone Burst Velocity)
* Một tài khoản Google mới tạo dưới 48 giờ chưa có lịch sử duyệt web, không có email, không có thiết bị Android/Chrome gắn liền.
* Nếu tài khoản này lập tức gửi hàng triệu token reasoning với tốc độ hàng chục request mỗi phút vào backend Cloud Code, hệ thống bảo mật tự động sẽ gắn nhãn "Account Farming / Bot" và kích hoạt mã lỗi `403 VALIDATION_REQUIRED` ngay lập tức.

---

## 4. Đánh Giá Kiến Trúc Phòng Thủ Của `atc`

Codebase của `atc` đã được thiết kế sẵn nhiều cơ chế phòng thủ chuyên sâu để giải quyết các rủi ro trên:

### 4.1. Những Lớp Bảo Vệ Đã Hoạt Động Hiệu Quả
1. **Isolated HTTP/1.1 Connection Pools (`src/utils/upstream-transport.js`)**:
   * Mỗi tài khoản được cấp một `https.Agent` hoàn toàn độc lập (tối đa 64 pool riêng).
   * Triệt tiêu 100% rủi ro rò rỉ hoặc tái sử dụng socket TCP/TLS giữa các tài khoản khác nhau.
2. **Socket Idle Eviction (30 giây)**:
   * Ngắt kết nối socket sau 30 giây không hoạt động (thấp hơn nhiều so với ngưỡng cắt ~240s của GFE), đảm bảo không để lại kết nối treo kéo dài gây nghi ngờ.
3. **Wire Headers Tối Giản**:
   * Chuẩn hóa chính xác các header của native Go client: `User-Agent`, `Content-Type`, `Content-Length`, `Accept-Encoding: gzip`, `Authorization`.
   * Loại bỏ toàn bộ các header rò rỉ từ browser/fetch (`sec-fetch-*`, `accept-language`).
4. **Safety Shield Khóa Vòng Lặp Refresh Token (`src/account-manager/credentials.js`)**:
   * Khi tài khoản bị đánh dấu lỗi `isInvalid` do ToS, suspended, banned hoặc `invalid_grant`, `atc` **chặn đứng toàn bộ việc tự động gọi refresh token trong nền**.
   * Điều này ngăn hiện tượng proxy liên tục bắn request lỗi lên máy chủ OAuth của Google, tránh biến một lỗi tạm thời thành lệnh khóa tài khoản vĩnh viễn.
5. **Bộ Đệm Jitter & Burst Pacer**:
   * Giãn cách tự động các request đồng thời từ các subagent của Claude Code với độ trễ ngẫu nhiên ~250ms, triệt tiêu các đỉnh nhọn lưu lượng bất thường.

### 4.2. Phân Cấp Mức Độ An Toàn Của 10 Chiến Lược Trong `atc`

```text
[MỨC ĐỘ RỦI RO CỦA CÁC CHIẾN LƯỢC TRONG ATC]

  locked          day-split        session          warmup          pipelined        round-robin
 [safest]  ----  [very-safe]  ----  [safe]   ----   [shield]  ----  [moderate]  ----  [DEADLY]
    │                 │                │               │              │               │
    ▼                 ▼                ▼               ▼              ▼               ▼
1 account        Max 2 acc/ngày   Chỉ đổi khi    Bảo vệ clone    Đổi mỗi 5%      Đổi liên tục
Zero-hopping    Không fan-out IP  nghỉ >= 3 phút  mới (<48h)    Dễ lộ chu kỳ     Lộ 100% ngữ cảnh
```

* **`locked` (An toàn tuyệt đối)**: Khóa cứng 1 tài khoản duy nhất. Không xoay vòng, không có tín hiệu multi-account.
* **`day-split` (Khuyên dùng cho nhiều gói độc lập)**: Mỗi ngày chỉ bầu ra 1 Primary và 1 Standby. Giữ tỷ lệ IP-to-Account luôn ở mức tối đa 1:2, nằm hoàn toàn trong ngưỡng hành vi người dùng tự nhiên.
* **`session` (Chiến lược cân bằng nhất)**: Bắt buộc phiên làm việc kéo dài tối thiểu ~45 phút và chỉ đổi tài khoản khi có khoảng lặng nghỉ ngơi thực tế ($\ge 3$ phút); không bao giờ đổi tài khoản giữa chừng một chuỗi tool call.
* **`warmup` (Tấm khiên cho clone mới)**: Giới hạn lưu lượng nhỏ giọt (tối đa 5 request / 45 phút) cho các tài khoản mới dưới 48 giờ để xây dựng lịch sử uy tín (reputation score).
* **`round-robin` (TUYỆT ĐỐI TRÁNH)**: Đổi tài khoản liên tục sau mỗi request; để lộ 100% chữ ký bot qua hiện tượng Request Interleaving.

---

## 5. Cẩm Nang Vận Hành An Toàn Tuyệt Đối Cho Vibe-Coder

Để khai thác tối đa tài nguyên mà không bao giờ đối mặt với nguy cơ mất tài khoản Google, hãy tuân thủ nghiêm ngặt 5 nguyên tắc sau:

### Nguyên Tắc 1: Kiến Trúc Cách Ly (Family Manager Clean + Dedicated Clone)
* **Tài khoản chính (Primary Account)**: Nơi lưu trữ Gmail, Google Drive, ảnh gia đình, lịch sử cá nhân và thẻ thanh toán.
  * Mua gói Google One AI Pro / Ultra trên tài khoản này.
  * Bật tính năng chia sẻ gia đình tại `one.google.com`.
  * **TUYỆT ĐỐI KHÔNG** đăng nhập OAuth tài khoản này vào `atc` hay bất kỳ tool proxy nào.
* **Tài khoản phụ (Dedicated Clone)**:
  * Tạo một tài khoản Google riêng (phải xác minh trên 18 tuổi, cùng quốc gia với tài khoản chính).
  * Mời tài khoản phụ này vào nhóm gia đình tại `families.google.com`.
  * **Chỉ đưa tài khoản phụ này vào `atc`**.
  * **Lợi ích**: Nếu có xảy ra đợt quét lỗi 403 ToS, lệnh đình chỉ chỉ rơi vào tài khoản phụ; tài khoản chính và toàn bộ dữ liệu cá nhân hoàn toàn vô sự.

### Nguyên Tắc 2: Quy Tắc "Một Family Group = Một Tài Khoản Trong Proxy"
* Không bao giờ thêm 2 hoặc nhiều tài khoản thuộc cùng một nhóm Family vào pool của `atc`.
* Do hạn ngạch là dùng chung, việc xoay vòng giữa các thành viên trong cùng một gia đình là vô nghĩa về mặt dung lượng, nhưng lại làm tăng gấp bội tín hiệu bất thường trên địa chỉ IP.

### Nguyên Tắc 3: Chọn Đúng Chiến Lược Điều Phối
* Nếu chỉ có 1 gói thuê bao (hoặc 1 Family clone): Bật ngay chế độ khóa:
  ```bash
  atc lock on
  ```
* Nếu sở hữu nhiều gói thuê bao độc lập từ các nguồn khác nhau: Chuyển sang chiến lược `session` hoặc `day-split` trong phần cài đặt:
  ```bash
  atc settings
  ```
  *(Chọn tab Balancer $\rightarrow$ Đặt chiến lược thành `session` với `idleBreakSec: 180`).*

### Nguyên Tắc 4: Định Tuyến Subagent Sang Model Nhẹ
* Claude Code thường xuyên chạy các subagent nền song song để tìm kiếm file (`Glob`), quét nội dung (`Grep`) hoặc đọc tài liệu.
* Hãy cấu hình trong `atc mapid` để trỏ `CLAUDE_CODE_SUBAGENT` về `gemini-3.1-flash-lite`.
* **Tác dụng**: Giảm thiểu tới 80% áp lực request lên hạn ngạch 5 giờ của model đầu bảng, đồng thời hạn chế các đợt bùng nổ lưu lượng dễ kích hoạt bộ lọc bảo vệ.

### Nguyên Tắc 5: Phản Ứng Đúng Khi Gặp Lỗi 403
* **Khi thấy trạng thái `[verify-req]` trên dashboard**:
  * Đây là lỗi `VALIDATION_REQUIRED` (Google yêu cầu xác minh danh tính hoặc đồng ý điều khoản mới).
  * Bấm phím `V` trên giao diện TUI để mở đường link xác minh trong trình duyệt.
  * Hoàn thành xác minh xong mới tiếp tục sử dụng. Tuyệt đối không spam lệnh đăng nhập lại.
* **Khi thấy trạng thái `[banned]`**:
  * Quyền truy cập Cloud Code của tài khoản đã bị khóa do vi phạm ToS.
  * `atc` đã tự động cô lập tài khoản này để bảo vệ các tài khoản khác trong pool.
  * Gỡ tài khoản này ra khỏi pool (`atc remove <id>`) và chuẩn bị một clone thay thế theo đúng quy trình cách ly ở Nguyên Tắc 1.
