# Clari API Documentation

## 개요

Clari API는 AI 기반 실시간 음성 녹음, 전사(STT), 키워드 추출, 외부 자료 참조 기능을 제공하는 RESTful API입니다.

**Base URL**: `http://localhost:3000`

---

## 인증

대부분의 엔드포인트는 JWT 기반 인증이 필요합니다.

### 인증 헤더 형식
```
Authorization: Bearer <access_token>
```

---

## 엔드포인트

### 1. 인증 (Authentication)

#### `POST /auth/google`
Google OAuth2를 통한 사용자 인증

**요청 바디**:
```json
{
  "idToken": "google_id_token"
}
```

**응답**:
```json
{
  "accessToken": "jwt_access_token",
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "User Name",
    "profileUrl": "https://..."
  }
}
```

---

### 2. 사용자 정보

#### `GET /me`
현재 로그인한 사용자 정보 조회

**인증**: 필요

**응답**:
```json
{
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "User Name",
    "profileUrl": "https://..."
  }
}
```

---

### 3. 노트 (Notes)

#### `GET /notes`
사용자의 노트 목록 조회

**인증**: 필요

**쿼리 파라미터**:
- `limit` (optional): 반환할 노트 수 (기본값: 10)
- `sort` (optional): 정렬 방식
  - `recent_used`: 최근 업데이트순 (기본값)
  - `recent_created`: 최근 생성순

**응답**:
```json
{
  "notes": [
    {
      "id": "note_id",
      "title": "Note Title",
      "durationInSeconds": 120,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "lastUpdated": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `GET /notes/:id`
특정 노트 상세 조회

**인증**: 필요 (공개 노트는 비인증도 가능)

**응답**:
```json
{
  "note": {
    "id": "note_id",
    "title": "Note Title",
    "content": "...",
    "recordingUrl": "https://...",
    "durationInSeconds": 120,
    "recordingStatus": "completed",
    "aiSummary": "요약 내용",
    "speakers": [
      {
        "speaker_id": "0",
        "speaker_name": "참석자 1"
      }
    ],
    "isPublic": false,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `PATCH /notes/:id`
노트 정보 수정

**인증**: 필요

**요청 바디**:
```json
{
  "title": "Updated Title",
  "speakers": [
    {
      "speaker_id": "0",
      "speaker_name": "홍길동"
    }
  ]
}
```

**응답**:
```json
{
  "note": {
    "id": "note_id",
    "title": "Updated Title",
    ...
  }
}
```

#### `DELETE /notes/:id`
노트 삭제

**인증**: 필요

**응답**:
```json
{
  "message": "Note deleted successfully"
}
```

---

### 4. 녹음 세션 (Recording Sessions)

#### `POST /notes/session`
새로운 녹음 세션 생성

**인증**: 필요

**요청 바디**:
```json
{
  "title": "Meeting Recording",
  "languageCode": "ko",
  "keywordPackIds": ["pack_id_1", "pack_id_2"],
  "externalResourceIds": ["resource_id_1"]
}
```

**응답**:
```json
{
  "sessionId": "session_id",
  "noteId": "note_id",
  "message": "Session created. Connect to WebSocket to start recording."
}
```

#### `POST /notes/session/stop`
녹음 세션 종료 및 전사 처리

**인증**: 필요

**요청 바디**:
```json
{
  "sessionId": "session_id"
}
```

**응답**:
```json
{
  "message": "Recording completed and transcribed successfully",
  "recordingUrl": "https://...",
  "durationInSeconds": 120,
  "transcript": {
    "text": "원본 텍스트",
    "formatted": "교정된 텍스트",
    "language": "ko",
    "language_probability": 0.99,
    "word_count": 150
  },
  "speakers": [
    {
      "speaker_id": "0",
      "text": "화자별 발화 내용",
      "word_count": 75
    }
  ]
}
```

#### `POST /notes/session/cancel`
녹음 세션 취소 및 삭제

**인증**: 필요

**요청 바디**:
```json
{
  "sessionId": "session_id"
}
```

**응답**:
```json
{
  "message": "Recording cancelled and deleted successfully",
  "sessionId": "session_id"
}
```

#### `GET /notes/record/:noteId`
완료된 녹음 파일 URL 조회

**인증**: 필요 (공개 노트는 비인증도 가능)

**응답**:
```json
{
  "recordingUrl": "https://...",
  "durationInSeconds": 120
}
```

---

### 5. 녹음 WebSocket

#### `WS /notes/session/:sessionId`
실시간 오디오 스트리밍 및 전사

**인증**: 필요 (토큰은 쿼리 파라미터 또는 Authorization 헤더로 전달)

**연결**:
```
ws://localhost:3000/notes/session/{sessionId}?token={jwt_token}
```

**클라이언트 → 서버 (오디오 전송)**:
```json
{
  "audio": "base64_encoded_pcm_audio"
}
```

**클라이언트 → 서버 (키워드 감지 제어)**:
```json
{
  "action": "keyword.control",
  "data": "on" // or "off"
}
```

**클라이언트 → 서버 (힌트 제어)**:
```json
{
  "action": "hints.control",
  "data": "on" // or "off"
}
```

**서버 → 클라이언트 이벤트**:

1. **연결 준비 완료**:
```json
{
  "type": "ready",
  "sessionId": "session_id",
  "message": "Ready to record"
}
```

2. **부분 전사 (실시간)**:
```json
{
  "type": "partial",
  "text": "실시간 인식 중인 텍스트"
}
```

3. **확정 전사**:
```json
{
  "type": "committed",
  "text": "확정된 텍스트"
}
```

4. **GPT 교정 완료**:
```json
{
  "type": "formatted",
  "text": "교정된 텍스트"
}
```

5. **키워드 감지**:
```json
{
  "type": "keywords",
  "keywords": [
    {
      "name": "React",
      "description": "JavaScript 라이브러리"
    }
  ]
}
```

6. **외부 자료 힌트**:
```json
{
  "type": "hints",
  "hints": [
    {
      "resourceId": "resource_id",
      "resourceTitle": "자료 제목",
      "hint": "관련 내용",
      "sourceUrl": "https://..."
    }
  ]
}
```

7. **키워드 감지 상태**:
```json
{
  "type": "keyword.status",
  "enabled": true
}
```

8. **힌트 상태**:
```json
{
  "type": "hints.status",
  "enabled": true
}
```

9. **에러**:
```json
{
  "type": "error",
  "error": "Error message"
}
```

---

### 6. 실시간 STT WebSocket (간단 버전)

#### `WS /ws/stt`
실시간 음성-텍스트 변환 (별도 세션 생성 없이 사용)

**연결**:
```
ws://localhost:3000/ws/stt
```

**클라이언트 → 서버**:
```json
{
  "audio": "base64_encoded_pcm_audio"
}
```

**서버 → 클라이언트**:

1. **부분 전사**:
```json
{
  "type": "partial",
  "text": "실시간 인식 중",
  "chunks": ["실시간", "인식 중"]
}
```

2. **확정 전사**:
```json
{
  "type": "committed",
  "text": "확정된 텍스트",
  "chunks": ["확정된", "텍스트"]
}
```

3. **교정 완료**:
```json
{
  "type": "formatted",
  "text": "교정된 텍스트",
  "chunks": ["교정된", "텍스트"]
}
```

---

### 7. 키워드 팩 (Keyword Packs)

#### `GET /keywordpacks`
사용자의 키워드 팩 목록 조회

**인증**: 필요

**쿼리 파라미터**:
- `limit` (optional): 반환할 팩 수 (기본값: 50)

**응답**:
```json
{
  "packs": [
    {
      "id": "pack_id",
      "name": "JavaScript 용어",
      "keywords": [
        {
          "name": "React",
          "description": "UI 라이브러리"
        }
      ],
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "isPublic": false,
      "previewImageUrl": "https://..."
    }
  ]
}
```

#### `GET /keywordpacks/:id`
특정 키워드 팩 조회

**인증**: 필요 (공개 팩은 비인증도 가능)

**응답**:
```json
{
  "pack": {
    "id": "pack_id",
    "name": "JavaScript 용어",
    "keywords": [...],
    "isPublic": false,
    "previewImageUrl": "https://...",
    "authorId": "user_id",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `POST /keywordpacks`
새 키워드 팩 생성

**인증**: 필요

**요청 바디**:
```json
{
  "name": "JavaScript 용어",
  "keywords": [
    {
      "name": "React",
      "description": "UI 라이브러리"
    }
  ],
  "isPublic": false
}
```

**응답**:
```json
{
  "pack": {
    "id": "pack_id",
    "name": "JavaScript 용어",
    ...
  }
}
```

#### `POST /keywordpacks/:id/keywords`
키워드 팩에 키워드 추가

**인증**: 필요

**요청 바디**:
```json
{
  "name": "Vue",
  "description": "프로그레시브 프레임워크"
}
```

**응답**:
```json
{
  "pack": {
    "id": "pack_id",
    "keywords": [...]
  }
}
```

#### `PATCH /keywordpacks/:id`
키워드 팩 수정

**인증**: 필요

**요청 바디**:
```json
{
  "name": "Updated Name",
  "keywords": [...],
  "isPublic": true,
  "previewImageUrl": "https://..."
}
```

**응답**:
```json
{
  "pack": {
    "id": "pack_id",
    ...
  }
}
```

#### `DELETE /keywordpacks/:id`
키워드 팩 삭제

**인증**: 필요

**응답**:
```json
{
  "message": "Keyword pack deleted successfully"
}
```

#### `POST /keywordpacks/ai/autocomplete`
AI를 이용한 키워드 설명 자동완성 (5개 제안)

**인증**: 필요

**요청 바디**:
```json
{
  "name": "React"
}
```

**응답**:
```json
{
  "suggestions": [
    "JavaScript 기반 UI 라이브러리",
    "컴포넌트 기반 프론트엔드 프레임워크",
    "Facebook에서 개발한 오픈소스 라이브러리",
    "가상 DOM을 사용하는 선언적 UI 라이브러리",
    "단일 페이지 애플리케이션 개발에 사용"
  ]
}
```

#### `POST /keywordpacks/ai/autofill`
AI를 이용한 주제별 키워드 자동 생성

**인증**: 필요

**요청 바디**:
```json
{
  "query": "React 프로그래밍",
  "count": 50
}
```

**응답**:
```json
{
  "keywords": [
    {
      "name": "JSX",
      "description": "JavaScript XML 문법 확장"
    },
    {
      "name": "Virtual DOM",
      "description": "가상 DOM 렌더링 기술"
    }
  ],
  "stats": {
    "perplexityTime": 2500,
    "gptTime": 3000,
    "totalTime": 5500,
    "requestedCount": 50,
    "actualCount": 48
  }
}
```

---

### 8. 외부 자료 (External Resources)

#### `GET /externalresources`
사용자의 외부 자료 목록 조회

**인증**: 필요

**쿼리 파라미터**:
- `limit` (optional): 반환할 자료 수 (기본값: 50)

**응답**:
```json
{
  "resources": [
    {
      "id": "resource_id",
      "url": "https://example.com",
      "displayUrl": "https://example.com",
      "title": "자료 제목",
      "logoUrl": "https://...",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `GET /externalresources/:id`
특정 외부 자료 상세 조회

**인증**: 필요

**응답**:
```json
{
  "resource": {
    "id": "resource_id",
    "url": "https://example.com",
    "displayUrl": "https://example.com",
    "title": "자료 제목",
    "logoUrl": "https://...",
    "scrapedContent": "스크랩된 마크다운 내용...",
    "metadata": {...},
    "authorId": "user_id",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `POST /externalresources`
새 외부 자료 추가 (Firecrawl로 웹 스크래핑)

**인증**: 필요

**요청 바디**:
```json
{
  "url": "https://example.com/article"
}
```

**응답**:
```json
{
  "resource": {
    "id": "resource_id",
    "url": "https://example.com/article",
    "displayUrl": "https://example.com/article",
    "title": "AI 생성 제목",
    "logoUrl": "https://...",
    "scrapedContent": "...",
    "metadata": {...},
    "authorId": "user_id",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `PATCH /externalresources/:id`
외부 자료 제목 수정 (제목만 수정 가능, 최대 10자)

**인증**: 필요

**요청 바디**:
```json
{
  "title": "새 제목"
}
```

**응답**:
```json
{
  "resource": {
    "id": "resource_id",
    "title": "새 제목",
    ...
  }
}
```

#### `DELETE /externalresources/:id`
외부 자료 삭제

**인증**: 필요

**응답**:
```json
{
  "message": "External resource deleted successfully"
}
```

---

## 에러 응답

모든 에러는 다음 형식으로 반환됩니다:

```json
{
  "error": "Error message"
}
```

**HTTP 상태 코드**:
- `400`: Bad Request (잘못된 요청)
- `401`: Unauthorized (인증 실패)
- `403`: Forbidden (권한 없음)
- `404`: Not Found (리소스 없음)
- `500`: Internal Server Error (서버 오류)

---

## 기술 스택

- **Runtime**: Bun
- **Framework**: Hono
- **Database**: PostgreSQL + Prisma
- **STT**: ElevenLabs Scribe v2
- **AI**: Azure OpenAI (GPT-4)
- **Web Scraping**: Firecrawl
- **Storage**: Cloudflare R2
- **Authentication**: Google OAuth2 + JWT

---

## 오디오 포맷

WebSocket으로 전송하는 오디오는 다음 사양을 따라야 합니다:

- **포맷**: PCM (16-bit)
- **샘플링 레이트**: 16000 Hz
- **채널**: 모노 (1채널)
- **인코딩**: Base64

---

## 환경 변수

API를 실행하려면 다음 환경 변수가 필요합니다:

```env
# Database
DATABASE_URL=postgresql://...

# JWT
JWT_SECRET=your-jwt-secret

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id

# ElevenLabs
ELEVENLABS_API_KEY=your-elevenlabs-api-key

# Azure OpenAI
AZURE_ENDPOINT=https://...
AZURE_API_KEY=your-azure-api-key
AZURE_API_VERSION=2023-07-01-preview
AZURE_DEPLOYMENT_NAME=gpt-4

# Perplexity AI
PERPLEXITY_API_KEY=your-perplexity-api-key

# Firecrawl
FIRECRAWL_API_KEY=your-firecrawl-api-key

# Cloudflare R2
R2_ACCOUNT_ID=your-r2-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=your-bucket-name
```

---

## 개발 서버 실행

```bash
bun run dev
```

서버는 `http://localhost:3000`에서 실행됩니다.

---

## 라이선스

Proprietary
