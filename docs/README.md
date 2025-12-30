# 📚 Clari API Documentation

> AI 기반 실시간 음성 녹음 및 전사 API

[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)](https://bun.sh)
[![Hono](https://img.shields.io/badge/Hono-4.0+-orange?logo=hono)](https://hono.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-blue?logo=postgresql)](https://postgresql.org)
[![Prisma](https://img.shields.io/badge/Prisma-7.0+-2D3748?logo=prisma)](https://prisma.io)

---

## 📖 목차

- [개요](#-개요)
- [시스템 아키텍처](#-시스템-아키텍처)
- [주요 기능](#-주요-기능)
- [기술 스택](#-기술-스택)
- [API 엔드포인트](#-api-엔드포인트)
- [WebSocket 프로토콜](#-websocket-프로토콜)
- [데이터베이스 스키마](#-데이터베이스-스키마)
- [시작하기](#-시작하기)
- [환경 변수](#-환경-변수)

---

## 🎯 개요

**Clari API**는 실시간 음성 녹음, STT(Speech-to-Text), AI 기반 텍스트 교정, 키워드 자동 추출, 외부 자료 참조 기능을 제공하는 RESTful + WebSocket API입니다.

### 핵심 가치

- 🎙️ **실시간 음성 전사**: ElevenLabs Scribe v2를 활용한 고품질 STT
- 🤖 **AI 텍스트 처리**: GPT-4 기반 자동 교정, 요약, 제목 생성
- 🔍 **키워드 자동 추출**: Perplexity AI + GPT-4 연동
- 📚 **외부 자료 연동**: Firecrawl 기반 웹 스크래핑
- 👥 **화자 구분**: 자동 화자 분리(Diarization)

---

## 🏗️ 시스템 아키텍처

```mermaid
graph TB
    subgraph Client["📱 Client Layer"]
        WEB[Web Client]
        MOBILE[Mobile App]
    end

    subgraph API["🚀 API Gateway (Hono + Bun)"]
        AUTH[🔐 Auth Service]
        NOTE[📝 Note Service]
        REC[🎙️ Recording Service]
        KW[🏷️ Keyword Service]
        EXT[🌐 Resource Service]
    end

    subgraph AI["🤖 AI Services"]
        ELEVEN[ElevenLabs STT]
        GPT[Azure OpenAI GPT-4]
        PERP[Perplexity AI]
        FIRE[Firecrawl]
    end

    subgraph Data["💾 Data & Storage"]
        DB[(PostgreSQL)]
        R2[Cloudflare R2]
    end

    WEB --> API
    MOBILE --> API
    
    AUTH --> DB
    NOTE --> DB
    REC --> DB
    KW --> DB
    EXT --> DB
    
    REC --> ELEVEN
    REC --> GPT
    REC --> R2
    
    KW --> GPT
    KW --> PERP
    
    EXT --> FIRE
    EXT --> GPT

    style API fill:#fff2cc,stroke:#d6b656
    style AI fill:#e1d5e7,stroke:#9673a6
    style Data fill:#f8cecc,stroke:#b85450
```

### 레이어별 설명

| 레이어 | 설명 | 기술 스택 |
|--------|------|----------|
| **Client** | 사용자 인터페이스 | Web, Mobile (REST + WebSocket) |
| **API Gateway** | 비즈니스 로직 처리 | Hono, Bun, Prisma |
| **AI Services** | AI/ML 처리 | ElevenLabs, Azure OpenAI, Perplexity, Firecrawl |
| **Data Layer** | 데이터 저장 | PostgreSQL, Cloudflare R2 |

---

## ✨ 주요 기능

### 1. 🎙️ 실시간 음성 녹음 & 전사

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant E as ElevenLabs
    participant G as GPT-4
    participant R as R2

    C->>A: POST /notes/session
    A-->>C: sessionId
    C->>A: WS Connect
    
    loop Real-time
        C->>A: Audio Chunk
        A->>E: Stream Audio
        E-->>A: Partial Transcript
        A-->>C: Live Text
        E-->>A: Committed Text
        A->>G: Format Text
        G-->>A: Formatted
        A-->>C: Final Text
    end
    
    C->>A: Stop Recording
    A->>R: Upload WAV
    A->>E: Full STT + Diarization
    A->>G: Summary + Title
    A-->>C: Complete Result
```

**특징:**
- ⚡ 실시간 음성 인식 (Partial + Committed Transcript)
- ✍️ GPT-4 자동 텍스트 교정
- 👥 화자 자동 구분 (Diarization)
- 📊 요약 및 제목 자동 생성
- 💾 Cloudflare R2에 WAV 파일 저장

### 2. 🏷️ AI 키워드 자동 생성

```mermaid
graph LR
    A[User Query] --> B[Perplexity AI]
    B --> C[Search Results]
    C --> D[GPT-4 Extraction]
    D --> E[Structured Keywords]
    
    style B fill:#b0e3e6
    style D fill:#b0e3e6
```

**기능:**
- 🔍 **AI Autocomplete**: 단일 키워드에 대한 5가지 설명 생성
- 📦 **AI Autofill**: 주제에 맞는 50+ 키워드 자동 생성
- 🌐 Perplexity AI로 검색 후 GPT-4로 정제

### 3. 🌐 외부 자료 스크래핑

- 📄 Firecrawl로 웹페이지 스크래핑 (Markdown + HTML)
- 🤖 GPT-4로 짧은 제목 자동 생성 (최대 10자)
- 💡 녹음 중 관련 힌트 실시간 제공

### 4. 🔐 인증 & 권한 관리

- 🔑 Google OAuth2 인증
- 🎫 JWT 기반 토큰 관리
- 👤 사용자별 데이터 격리

---

## 🛠️ 기술 스택

### Backend

| 분류 | 기술 | 용도 |
|------|------|------|
| **Runtime** | Bun 1.0+ | JavaScript/TypeScript 실행 환경 |
| **Framework** | Hono 4.0+ | 경량 웹 프레임워크 |
| **Database** | PostgreSQL 15+ | 관계형 데이터베이스 |
| **ORM** | Prisma 7.0+ | 타입 안전 데이터베이스 접근 |

### AI & External Services

| 서비스 | 용도 |
|--------|------|
| **ElevenLabs** | 실시간 STT (Scribe v2 Realtime) |
| **Azure OpenAI** | GPT-4 텍스트 처리 (교정, 요약, 제목) |
| **Perplexity AI** | 키워드 검색 |
| **Firecrawl** | 웹 스크래핑 |
| **Google OAuth2** | 사용자 인증 |
| **Cloudflare R2** | 오디오 파일 저장 |

---

## 📡 API 엔드포인트

> 자세한 내용은 [API.md](./API.md)를 참고하세요.

### 인증

| Method | Endpoint | 설명 |
|--------|----------|------|
| `POST` | `/auth/google` | Google OAuth2 로그인 |
| `GET` | `/me` | 현재 사용자 정보 |

### 노트

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/notes` | 노트 목록 조회 |
| `GET` | `/notes/:id` | 노트 상세 조회 |
| `PATCH` | `/notes/:id` | 노트 수정 |
| `DELETE` | `/notes/:id` | 노트 삭제 |

### 녹음 세션

| Method | Endpoint | 설명 |
|--------|----------|------|
| `POST` | `/notes/session` | 녹음 세션 생성 |
| `POST` | `/notes/session/stop` | 녹음 종료 |
| `POST` | `/notes/session/cancel` | 녹음 취소 |
| `WS` | `/notes/session/:id` | 실시간 녹음 스트리밍 |
| `GET` | `/notes/record/:noteId` | 녹음 파일 URL 조회 |

### 키워드 팩

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/keywordpacks` | 키워드 팩 목록 |
| `GET` | `/keywordpacks/:id` | 키워드 팩 조회 |
| `POST` | `/keywordpacks` | 키워드 팩 생성 |
| `POST` | `/keywordpacks/:id/keywords` | 키워드 추가 |
| `PATCH` | `/keywordpacks/:id` | 키워드 팩 수정 |
| `DELETE` | `/keywordpacks/:id` | 키워드 팩 삭제 |
| `POST` | `/keywordpacks/ai/autocomplete` | AI 키워드 설명 생성 |
| `POST` | `/keywordpacks/ai/autofill` | AI 키워드 자동 생성 |

### 외부 자료

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/externalresources` | 외부 자료 목록 |
| `GET` | `/externalresources/:id` | 외부 자료 조회 |
| `POST` | `/externalresources` | 외부 자료 추가 (스크래핑) |
| `PATCH` | `/externalresources/:id` | 외부 자료 수정 |
| `DELETE` | `/externalresources/:id` | 외부 자료 삭제 |

### 실시간 STT

| Method | Endpoint | 설명 |
|--------|----------|------|
| `WS` | `/ws/stt` | 간단한 실시간 STT (세션 불필요) |

---

## 🔌 WebSocket 프로토콜

### 녹음 WebSocket: `/notes/session/:sessionId`

#### 클라이언트 → 서버

**오디오 전송:**
```json
{
  "audio": "base64_encoded_pcm_audio"
}
```

**키워드 감지 제어:**
```json
{
  "action": "keyword.control",
  "data": "on" // or "off"
}
```

**힌트 제어:**
```json
{
  "action": "hints.control",
  "data": "on" // or "off"
}
```

#### 서버 → 클라이언트

| Event Type | 설명 | 예시 |
|------------|------|------|
| `ready` | 연결 준비 완료 | `{type: "ready", sessionId: "..."}` |
| `partial` | 실시간 인식 중 | `{type: "partial", text: "안녕하"}` |
| `committed` | 확정된 텍스트 | `{type: "committed", text: "안녕하세요"}` |
| `formatted` | GPT 교정 완료 | `{type: "formatted", text: "안녕하세요."}` |
| `keywords` | 키워드 감지 | `{type: "keywords", keywords: [...]}` |
| `hints` | 자료 힌트 | `{type: "hints", hints: [...]}` |
| `error` | 에러 발생 | `{type: "error", error: "..."}` |

### 오디오 포맷 요구사항

```yaml
Format: PCM (16-bit signed integer)
Sample Rate: 16000 Hz
Channels: Mono (1)
Encoding: Base64
```

---

## 💾 데이터베이스 스키마

```mermaid
erDiagram
    User ||--o{ Note : creates
    User ||--o{ KeywordPack : creates
    User ||--o{ ExternalResource : creates

    User {
        uuid id PK
        string email UK
        string name
        string googleId UK
        string profileUrl
        datetime createdAt
        datetime updatedAt
    }

    Note {
        uuid id PK
        string title
        text content
        text aiSummary
        json speakers
        int durationInSeconds
        boolean isPublic
        string recordingUrl
        string recordingStatus
        datetime createdAt
        datetime updatedAt
        datetime lastUpdated
        uuid authorId FK
        array keywordPackIds
        array externalResourceIds
    }

    KeywordPack {
        uuid id PK
        string name
        json keywords
        datetime createdAt
        datetime updatedAt
        boolean isPublic
        string previewImageUrl
        uuid authorId FK
    }

    ExternalResource {
        uuid id PK
        string url
        string displayUrl
        string title
        string logoUrl
        text scrapedContent
        json metadata
        datetime createdAt
        datetime updatedAt
        uuid authorId FK
    }
```

### 주요 모델 설명

#### User
- Google OAuth2를 통한 사용자 인증
- 노트, 키워드 팩, 외부 자료 소유

#### Note
- 녹음 내용 및 메타데이터 저장
- `recordingStatus`: `pending` → `recording` → `completed` / `failed`
- `speakers`: 화자 정보 (JSON)
- `keywordPackIds`, `externalResourceIds`: 참조 자료 ID 배열

#### KeywordPack
- 사용자 정의 키워드 집합
- `keywords`: `{name, description}[]` 형태의 JSON

#### ExternalResource
- 스크래핑된 웹 자료
- `title`: 최대 10자 제한
- `scrapedContent`: Markdown/HTML 형태

---

## 🚀 시작하기

### 1. 사전 요구사항

- [Bun](https://bun.sh) 1.0 이상
- [PostgreSQL](https://postgresql.org) 15 이상
- 각종 API 키 (ElevenLabs, Azure OpenAI, Google OAuth2 등)

### 2. 설치

```bash
# 저장소 클론
git clone https://github.com/your-org/clari-api.git
cd clari-api

# 의존성 설치
bun install

# 환경 변수 설정
cp .env.example .env
# .env 파일을 열어 필요한 값들을 입력하세요
```

### 3. 데이터베이스 설정

```bash
# Prisma 마이그레이션 실행
bunx prisma migrate deploy

# Prisma Client 생성
bunx prisma generate
```

### 4. 개발 서버 실행

```bash
bun run dev
```

서버가 `http://localhost:3000`에서 실행됩니다.

### 5. API 테스트

```bash
# Health Check
curl http://localhost:3000

# 응답: {"message": "Clari API Server"}
```

---

## 🔐 환경 변수

`.env` 파일에 다음 변수들을 설정해야 합니다:

### 필수 환경 변수

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/clari"

# JWT
JWT_SECRET="your-secure-jwt-secret-key"

# Google OAuth
GOOGLE_CLIENT_ID="your-google-client-id.apps.googleusercontent.com"

# ElevenLabs
ELEVENLABS_API_KEY="your-elevenlabs-api-key"

# Azure OpenAI
AZURE_ENDPOINT="https://your-resource.openai.azure.com/"
AZURE_API_KEY="your-azure-api-key"
AZURE_API_VERSION="2023-07-01-preview"
AZURE_DEPLOYMENT_NAME="gpt-4"

# Perplexity AI
PERPLEXITY_API_KEY="your-perplexity-api-key"

# Firecrawl
FIRECRAWL_API_KEY="your-firecrawl-api-key"

# Cloudflare R2
R2_ACCOUNT_ID="your-r2-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
R2_BUCKET_NAME="your-bucket-name"
```

---

## 📊 녹음 플로우 상세

```mermaid
stateDiagram-v2
    [*] --> SessionCreated: POST /notes/session
    
    SessionCreated --> Recording: WebSocket Connect
    note right of Recording
        - Audio streaming
        - Real-time STT
        - Keyword detection
        - Resource hints
    end note
    
    Recording --> Processing: Stop Request
    
    Processing --> Uploading: Merge audio chunks
    Uploading --> Transcribing: Upload to R2
    Transcribing --> Formatting: ElevenLabs Full STT
    Formatting --> Summarizing: GPT-4 Format
    Summarizing --> TitleGen: GPT-4 Summary
    TitleGen --> Completed: GPT-4 Title
    
    Recording --> Cancelled: Cancel Request
    Processing --> Failed: Error
    
    Completed --> [*]
    Cancelled --> [*]: Delete Note
    Failed --> [*]
```

### 녹음 상태 설명

| 상태 | 설명 |
|------|------|
| `pending` | 세션 생성됨, WebSocket 연결 대기 |
| `recording` | 녹음 진행 중 |
| `processing` | 녹음 종료 후 후처리 중 |
| `completed` | 모든 처리 완료 |
| `failed` | 처리 중 오류 발생 |
| `cancelled` | 사용자가 취소 (Note 삭제됨) |

---

## 📖 추가 문서

- **[API.md](./API.md)** - 전체 API 명세서 (엔드포인트, 요청/응답 예시)
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - 시스템 아키텍처 상세 (Mermaid 다이어그램)
- **[clari-api-flow.drawio](./clari-api-flow.drawio)** - Draw.io 시스템 플로우 다이어그램

---

## 🤝 기여하기

이슈 제보 및 Pull Request는 언제나 환영합니다!

---

## 📄 라이선스

Proprietary - All rights reserved

---

## 📞 문의

프로젝트 관련 문의사항이 있으시면 이슈를 등록해주세요.

---

<div align="center">

**Made with ❤️ by Clari Team**

[🏠 홈페이지](#) | [📖 문서](./API.md) | [🐛 이슈 제보](#)

</div>
