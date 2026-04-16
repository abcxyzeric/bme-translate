# ST-BME — Hệ Sinh Thái Ký Ức Mô Phỏng Cho SillyTavern

> Để AI thật sự nhớ câu chuyện giữa bạn và nhân vật.

ST-BME là một extension bộ nhớ dài hạn cho SillyTavern. Extension này tự động trích xuất ký ức có cấu trúc từ hội thoại, lưu thành đồ thị, tính vector embedding và truy hồi lại các ký ức liên quan trước khi model tạo phản hồi tiếp theo. Mục tiêu là giữ cho các cuộc RP dài hơi không bị "mất trí nhớ", đồng thời cho phép bạn kiểm soát, theo dõi và sửa dữ liệu bộ nhớ khi cần.

## Tính năng chính

- Tự động trích xuất ký ức sau phản hồi AI.
- Truy hồi ký ức nhiều tầng trước khi gửi prompt tiếp theo.
- Đồ thị ký ức trực quan với giao diện chỉnh sửa nút, nhận thức và khu vực.
- Tách lớp khách quan / chủ quan / POV người dùng / POV nhân vật.
- Hỗ trợ thời gian cốt truyện, khu vực không gian và quan hệ kề cận.
- Hợp nhất ký ức trùng lặp, nén ký ức lâu ngày, phản tư dài hạn và cơ chế lãng quên.
- Khôi phục an toàn khi xóa tin, sửa tin, đổi swipe hoặc rebuild lại lịch sử.
- Lưu bền cục bộ bằng IndexedDB, có cơ chế dự phòng và đồng bộ theo chat.
- Hỗ trợ vector backend của SillyTavern hoặc embedding trực tiếp.
- Có panel quản trị, giám sát tác vụ, preview tiêm và công cụ thủ công.

## Cách hoạt động

ST-BME có ba trục chính: ghi vào, truy hồi và khôi phục.

### 1. Ghi vào đồ thị

Sau mỗi phản hồi AI, plugin gom phần hội thoại gần nhất và gửi cho một model bộ nhớ để nhận diện:

- Nhân vật
- Sự kiện
- Địa điểm
- Quy tắc thế giới
- Tuyến chính
- Ký ức POV
- Cập nhật nhận thức
- Gợi ý khu vực / thời gian cốt truyện

Sau đó plugin sẽ:

1. Chuẩn hóa hội thoại thành dữ liệu cấu trúc.
2. Lọc các phần thinking / analysis / reasoning nếu được cấu hình loại trừ.
3. So khớp với ký ức cũ bằng vector search.
4. Quyết định tạo mới, cập nhật hay hợp nhất.
5. Ghi vào đồ thị, cập nhật vector và metadata thời gian cốt truyện.

### 2. Truy hồi trước khi sinh

Ngay trước khi gửi prompt tiếp theo cho model chính, plugin sẽ:

1. Tách ý định từ đầu vào người dùng hiện tại.
2. Trộn truy vấn từ câu hiện tại, phản hồi AI trước đó và ngữ cảnh gần nhất.
3. Lọc trước bằng vector embedding.
4. Khuếch tán trên đồ thị để tìm các nút liên quan gián tiếp.
5. Cộng điểm bằng nhiều tín hiệu: vector, khoảng cách đồ thị, độ quan trọng, thời gian, ranh giới nhận thức.
6. Tùy chọn đưa danh sách ứng viên qua một vòng LLM rerank.
7. Chèn các ký ức đã chọn vào prompt.

### 3. Khôi phục khi lịch sử đổi

Nhiều plugin bộ nhớ bỏ qua chuyện người dùng xóa hoặc sửa tin nhắn. ST-BME không làm vậy.

Plugin lưu hash cho từng phần hội thoại đã xử lý. Nếu phát hiện lịch sử đổi:

1. Tìm vị trí sớm nhất bị ảnh hưởng.
2. Hoàn tác các ký ức và vector sinh ra sau mốc đó.
3. Chạy lại pipeline trích xuất từ điểm thay đổi.
4. Nếu cần thì rebuild toàn lượng để bảo đảm đúng dữ liệu.

## Mô hình dữ liệu

Plugin lưu ký ức thành các nút và cạnh trong đồ thị.

### Loại nút chính

- `character`: thông tin trạng thái nhân vật.
- `event`: sự kiện đã xảy ra.
- `location`: địa điểm và trạng thái địa điểm.
- `rule`: quy tắc, thiết lập, giới hạn của thế giới.
- `thread`: tuyến nhiệm vụ hoặc cốt truyện chính.
- `synopsis`: tóm tắt ngắn / tóm tắt hoạt động.
- `reflection`: kết luận xu hướng dài hạn.
- `pov_memory`: ký ức chủ quan từ góc nhìn cụ thể.

### Quan hệ nhận thức

ST-BME không coi mọi ký ức đều là sự thật mà mọi nhân vật cùng biết. Hệ thống phân ra:

- Tầng khách quan: dữ kiện của thế giới, sự kiện, địa điểm, quy tắc.
- Tầng POV nhân vật: niềm tin, cảm xúc, thái độ, hiểu lầm của từng nhân vật.
- POV người dùng: cảm nhận, thiên kiến, hứa hẹn hoặc bối cảnh tương tác từ phía người chơi.
- Cập nhật nhận thức: ai biết điều gì, ai hiểu sai điều gì, ai chỉ nhìn thấy một phần.

### Không gian và thời gian

Mỗi nút có thể mang:

- `regionPrimary`
- `regionPath`
- `regionSecondary`
- `storyTime`

Nhờ vậy, truy hồi có thể thiên về ký ức cùng khu vực, khu vực kề cận hoặc cùng giai đoạn cốt truyện.

## Cài đặt

### Cách 1: cài qua trang Extensions của SillyTavern

Nhập URL repo vào phần cài extension:

```text
https://github.com/Youzini-afk/ST-Bionic-Memory-Ecology
```

Sau đó reload SillyTavern.

### Cách 2: cài thủ công

1. Clone hoặc tải repo này về.
2. Chép vào thư mục extension của SillyTavern.
3. Khởi động lại SillyTavern.

## Bắt đầu nhanh

1. Mở menu SillyTavern và vào `ST-BME / đồ thị ký ức`.
2. Trong `Cấu hình`, bật ghi nhớ tự động và truy hồi trước khi sinh.
3. Vào `Cấu hình API` và chọn model bộ nhớ nếu muốn dùng riêng.
4. Chọn cách làm vector:
   - dùng backend vector của SillyTavern, hoặc
   - điền endpoint embedding trực tiếp.
5. Bắt đầu chat bình thường với nhân vật.
6. Mở panel để xem đồ thị, preview tiêm hoặc chạy thao tác thủ công.

## Cấu hình model

### Model bộ nhớ

Bạn có thể:

- Để trống để dùng lại model chat hiện tại.
- Chỉ định một model khác dành riêng cho trích xuất / truy hồi / hợp nhất / nén / phản tư.

### Vector embedding

Có hai chế độ:

#### Backend mode

Khuyên dùng khi có thể.

- Dùng vector API từ backend của SillyTavern.
- Ổn định hơn.
- Không phải tự lo CORS ở trình duyệt.
- Có thể tái sử dụng cấu hình hiện có của SillyTavern.

#### Direct mode

Dùng khi bạn cần endpoint embedding riêng.

- Điền URL API, key và model.
- Plugin sẽ gọi thẳng từ phía trình duyệt.
- Cần tự để ý vấn đề CORS / mixed content.

Nếu đổi model vector hoặc đổi chế độ vector, nên chạy `Xây lại vector` một lần.

## Cấu hình khuyên dùng

Nếu bạn chỉ muốn plugin chạy ổn ngay:

- Bật `Tự động ghi nhớ`.
- Bật `Truy hồi trước khi sinh`.
- Bật `Hợp nhất ký ức`.
- Bật `Tóm tắt phân tầng`.
- Dùng model bộ nhớ riêng nếu model chat chính quá đắt hoặc không ổn định ở đầu ra JSON.
- Dùng vector backend nếu SillyTavern host của bạn hỗ trợ.

Các mục nâng cao như phản tư, lãng quên, nén tự động, rerank bằng LLM có thể bật sau khi hệ nhớ cơ bản đã ổn định.

## Panel quản trị

Panel của ST-BME cho phép:

- Xem số nút hoạt động, cạnh, tỷ lệ phân mảnh, trạng thái vector, trạng thái lưu bền.
- Xem đồ thị trực tiếp.
- Duyệt ký ức theo danh sách.
- Xem preview phần truy hồi / phần tiêm.
- Xem trace tác vụ gần nhất.
- Chỉnh sửa hoặc xóa nút.
- Sửa nhận thức nhân vật / khu vực hiện tại / quan hệ kề cận.
- Chạy các thao tác thủ công như rebuild, compress, reflection, forget, retry persist.

## Khối chức năng lớn trong mã nguồn

### `index.js`

Điểm vào chính của extension. Quản lý vòng đời, gắn hook sự kiện SillyTavern, điều phối pipeline trích xuất, truy hồi, lưu bền và khôi phục.

### `graph/`

Các cấu trúc đồ thị, schema, timeline và trạng thái tóm tắt.

### `maintenance/`

Các pipeline bảo trì ký ức:

- extractor
- consolidator
- compressor
- hierarchical summary
- reflection
- forget / smart trigger

### `retrieval/`

Các pipeline truy hồi:

- vector prefilter
- graph diffusion
- ranking
- injection
- recall controller

### `prompting/`

Khung prompt cho từng loại tác vụ bộ nhớ, builder, regex và tích hợp world info.

### `ui/`

Panel, HTML, renderer đồ thị, card truy hồi, trạng thái giao diện và các thao tác chỉnh sửa tay.

### `vector/`

Tạo embedding, chỉ mục vector và truy vấn tương đồng.

### `sync/`

Quản lý IndexedDB, đồng bộ, snapshot, metadata theo chat.

### `host/`

Lớp adapter giữa extension và các API / event của SillyTavern.

### `ena-planner/`

Mô-đun phụ hỗ trợ định hướng cốt truyện / planner. Đây không phải lõi của memory graph, nhưng có thể dùng như lớp hỗ trợ nhịp truyện khi RP.

## ST-BME là gì nếu nói ngắn gọn?

Đây không phải chỉ là một bảng nhớ đơn giản, cũng không chỉ là planner cốt truyện.

Mô tả đúng nhất là:

- một engine bộ nhớ dài hạn dạng đồ thị cho SillyTavern,
- có lớp truy hồi theo ngữ cảnh,
- có ranh giới nhận thức và thời gian cốt truyện,
- có công cụ quan sát và chỉnh tay,
- và có thêm mô-đun planner phụ cho nhu cầu hỗ trợ nhịp truyện.

## Lưu ý hiệu năng

Một lượt hội thoại có thể tiêu tốn nhiều lần gọi model, thường là:

- trích xuất,
- hợp nhất / bảo trì,
- truy hồi,
- và thêm embedding nếu có cập nhật vector.

Vì vậy bạn nên:

- chọn model bộ nhớ rẻ hơn model chat chính nếu cần,
- giới hạn cửa sổ trích xuất khi hội thoại quá dài,
- chỉ bật các tác vụ nâng cao khi thật sự cần.

## Ghi chú tương thích bản dịch

Nếu bạn đang đọc bản README tiếng Việt trong bản fork dịch:

- phần tên biến / field kỹ thuật như `nodeId`, `chatId`, `pov_memory`, `storyTime`, `message.extra.bme_recall` nên giữ nguyên trong mã nguồn,
- phần giao diện, mô tả, thông báo, prompt tiếng Trung mới là phần cần Việt hóa,
- các key cấu hình cũ bằng tiếng Trung nếu có thì cần giữ tương thích khi migrate cấu hình cũ.
