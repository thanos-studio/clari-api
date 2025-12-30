# Clari API Architecture

## System Architecture

```mermaid
graph TB
    subgraph Client["Client Applications"]
        WEB[Web Client]
        MOBILE[Mobile App]
    end

    subgraph API["Clari API (Hono + Bun)"]
        AUTH[Auth Service]
        NOTE[Note Service]
        REC[Recording Service]
        KW[Keyword Service]
        EXT[External Resource Service]
        WS[WebSocket Handler]
    end

    subgraph External["External Services"]
        GOOGLE[Google OAuth2]
        ELEVEN[ElevenLabs STT]
        AZURE[Azure OpenAI GPT-4]
        PERP[Perplexity AI]
        FIRE[Firecrawl]
        R2[Cloudflare R2]
    end

    subgraph Data["Data Layer"]
        DB[(PostgreSQL)]
        PRISMA[Prisma ORM]
    end

    WEB -->|REST/WebSocket| API
    MOBILE -->|REST/WebSocket| API

    AUTH -->|Verify Token| GOOGLE
    AUTH -->|Generate JWT| AUTH

    REC -->|Real-time STT| ELEVEN
    REC -->|Text Correction| AZURE
    REC -->|Upload Audio| R2
    
    KW -->|AI Autocomplete| AZURE
    KW -->|AI Autofill| PERP
    KW -->|AI Autofill| AZURE

    EXT -->|Web Scraping| FIRE
    EXT -->|Generate Title| AZURE

    NOTE --> PRISMA
    REC --> PRISMA
    KW --> PRISMA
    EXT --> PRISMA
    AUTH --> PRISMA

    PRISMA --> DB

    WS -->|Audio Stream| ELEVEN
    WS -->|Transcript| CLIENT
```

## Database Schema (ERD)

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
        string[] keywordPackIds
        string[] externalResourceIds
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

## Recording Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant DB
    participant ElevenLabs
    participant GPT
    participant R2

    Client->>API: POST /notes/session
    API->>DB: Create Note (recording status)
    DB-->>API: Note ID (Session ID)
    API-->>Client: Session ID

    Client->>API: WS Connect /notes/session/:id
    API->>ElevenLabs: Connect STT WebSocket
    ElevenLabs-->>API: Connected

    loop Real-time Recording
        Client->>API: Audio Chunk (Base64 PCM)
        API->>ElevenLabs: Audio Data
        ElevenLabs-->>API: Partial Transcript
        API-->>Client: Partial Transcript
        ElevenLabs-->>API: Committed Transcript
        API->>GPT: Format Text
        GPT-->>API: Formatted Text
        API-->>Client: Formatted Transcript
        
        alt Keyword Detection Enabled
            API->>API: Match Keywords
            API-->>Client: Detected Keywords
        end
        
        alt Resource Hints Enabled
            API->>API: Search in Resources
            API-->>Client: Resource Hints
        end
    end

    Client->>API: POST /notes/session/stop
    API->>API: Finalize Recording
    API->>R2: Upload WAV File
    R2-->>API: Recording URL
    API->>ElevenLabs: STT with Diarization
    ElevenLabs-->>API: Full Transcript + Speakers
    API->>GPT: Format Full Text
    GPT-->>API: Formatted Text
    API->>GPT: Generate Summary
    GPT-->>API: Summary
    API->>GPT: Generate Title
    GPT-->>API: Title
    API->>DB: Update Note (completed)
    DB-->>API: Success
    API-->>Client: Recording Result
```

## Authentication Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Google
    participant DB

    Client->>Google: Login with Google
    Google-->>Client: ID Token
    Client->>API: POST /auth/google {idToken}
    API->>Google: Verify ID Token
    Google-->>API: User Info (email, name, picture)
    API->>DB: Find or Create User
    DB-->>API: User Data
    API->>API: Generate JWT
    API-->>Client: {accessToken, user}
    
    Note over Client,API: Subsequent Requests
    Client->>API: Request with JWT
    API->>API: Verify JWT
    API->>DB: Get User Data
    DB-->>API: User Data
    API-->>Client: Protected Resource
```

## Keyword Pack AI Autofill Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Perplexity
    participant GPT

    Client->>API: POST /keywordpacks/ai/autofill
    Note over Client,API: {query: "React", count: 50}
    
    API->>Perplexity: Search Technical Terms
    Note over API,Perplexity: "List 60 terms related to: React"
    Perplexity-->>API: Search Results (Raw Text)
    
    API->>GPT: Extract & Format Keywords
    Note over API,GPT: "Extract 50 terms with Korean descriptions"
    GPT-->>API: Structured Keywords JSON
    
    API-->>Client: {keywords: [...], stats: {...}}
    Note over Client,API: 50 keywords with names & descriptions
```

## External Resource Scraping Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Firecrawl
    participant GPT
    participant DB

    Client->>API: POST /externalresources {url}
    API->>Firecrawl: Scrape URL
    Note over API,Firecrawl: Markdown + HTML extraction
    Firecrawl-->>API: Scraped Content + Metadata
    
    API->>GPT: Generate Short Title
    Note over API,GPT: Max 10 characters
    GPT-->>API: Title
    
    API->>DB: Create ExternalResource
    DB-->>API: Resource Data
    API-->>Client: {resource: {...}}
    
    Note over Client,API: Resource available for hints during recording
```

## WebSocket Message Types

### Client → Server

```mermaid
graph LR
    A[Client] -->|Audio Data| B{Message Type}
    B -->|audio: base64| C[STT Processing]
    B -->|keyword.control: on/off| D[Toggle Keyword Detection]
    B -->|hints.control: on/off| E[Toggle Resource Hints]
```

### Server → Client

```mermaid
graph LR
    A[Server] --> B{Event Type}
    B -->|ready| C[Connection Ready]
    B -->|partial| D[Real-time Transcript]
    B -->|committed| E[Finalized Transcript]
    B -->|formatted| F[GPT Corrected Text]
    B -->|keywords| G[Detected Keywords]
    B -->|hints| H[Resource Hints]
    B -->|keyword.status| I[Detection Status]
    B -->|hints.status| J[Hints Status]
    B -->|error| K[Error Message]
```

## Technology Stack

```mermaid
graph TB
    subgraph Frontend
        A[Web/Mobile Client]
    end

    subgraph Backend
        B[Bun Runtime]
        C[Hono Framework]
        D[Prisma ORM]
    end

    subgraph Database
        E[(PostgreSQL)]
    end

    subgraph AI_Services["AI & ML Services"]
        F[ElevenLabs Scribe v2]
        G[Azure OpenAI GPT-4]
        H[Perplexity AI]
    end

    subgraph Tools["Additional Tools"]
        I[Firecrawl]
        J[Cloudflare R2]
        K[Google OAuth2]
    end

    A --> B
    B --> C
    C --> D
    D --> E
    C --> F
    C --> G
    C --> H
    C --> I
    C --> J
    A --> K
    C --> K
```

## Deployment Architecture

```mermaid
graph TB
    subgraph Internet
        CLIENT[Clients]
    end

    subgraph CloudInfra["Cloud Infrastructure"]
        LB[Load Balancer]
        
        subgraph AppServers["Application Servers"]
            APP1[Bun + Hono Instance 1]
            APP2[Bun + Hono Instance 2]
            APP3[Bun + Hono Instance N]
        end
        
        subgraph Database
            PRIMARY[(PostgreSQL Primary)]
            REPLICA[(PostgreSQL Replica)]
        end
        
        subgraph Storage
            R2[Cloudflare R2 Bucket]
        end
    end

    subgraph ExternalAPIs["External APIs"]
        GOOGLE[Google OAuth2]
        ELEVEN[ElevenLabs]
        AZURE[Azure OpenAI]
        PERP[Perplexity]
        FIRE[Firecrawl]
    end

    CLIENT --> LB
    LB --> APP1
    LB --> APP2
    LB --> APP3
    
    APP1 --> PRIMARY
    APP2 --> PRIMARY
    APP3 --> PRIMARY
    
    PRIMARY -.Replication.-> REPLICA
    
    APP1 --> R2
    APP2 --> R2
    APP3 --> R2
    
    APP1 --> GOOGLE
    APP1 --> ELEVEN
    APP1 --> AZURE
    APP1 --> PERP
    APP1 --> FIRE
```

## Data Flow: Note Creation to Completion

```mermaid
stateDiagram-v2
    [*] --> SessionCreated: POST /notes/session
    SessionCreated --> Recording: WebSocket Connect
    Recording --> Recording: Audio Streaming
    Recording --> Recording: Real-time Transcription
    Recording --> Processing: POST /notes/session/stop
    Processing --> Uploading: Finalize Audio
    Uploading --> Transcribing: Upload to R2
    Transcribing --> Formatting: ElevenLabs Full STT
    Formatting --> Summarizing: GPT Format
    Summarizing --> TitleGeneration: GPT Summarize
    TitleGeneration --> Completed: GPT Title
    Completed --> [*]
    
    Recording --> Cancelled: POST /notes/session/cancel
    Cancelled --> [*]
    
    Processing --> Failed: Error
    Uploading --> Failed: Error
    Transcribing --> Failed: Error
    Failed --> [*]
```

## Recording Status States

```mermaid
stateDiagram-v2
    [*] --> pending: Note Created
    pending --> recording: WebSocket Connected
    recording --> recording: Receiving Audio
    recording --> processing: Stop Requested
    processing --> completed: Success
    processing --> failed: Error
    recording --> cancelled: Cancel Requested
    
    completed --> [*]
    failed --> [*]
    cancelled --> [*]: Note Deleted
```
