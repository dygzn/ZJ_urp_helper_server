# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

URP Helper Server is a Flask-based web application for university URP (教务系统) educational management systems. Features include device-bound user authentication, educational data scraping (grades, evaluations), AI-powered paper generation via Claude API, and admin management.

## Development Commands

```bash
# Activate virtual environment (Windows)
.venv\Scripts\activate

# Run the Flask server (runs on http://0.0.0.0:5000)
python app.py

# Install dependencies
pip install -r requirements.txt
```

## Architecture

### Core Components

- **[app.py](app.py)** - Flask application with routes, authentication, SQLite database operations, and API endpoints
- **[URP.py](URP.py)** - URP system interaction
  - `URP_login`: Login, CAPTCHA recognition (ddddocr), cookie management
  - `URP_query`: Data scraping (grades, course evaluations)
  - VPN cookie mechanism via `http://101.35.254.245/vpn`
  - Cookies stored in `user_data/{account}/cookie.json`
- **[paper_generator.py](paper_generator.py)** - Academic paper generation
  - 5 templates: simple, standard, graduation, experiment, research
  - Section-by-section generation with SSE streaming progress
  - Citation renumbering and Word document formatting

### Data Flow

1. **User Binding**: `/api/login` → `URP_login.login()` → stores credentials in SQLite, cookies in `user_data/{account}/cookie.json`
2. **Data Query**: API endpoint → `@require_login` decorator → `URP_query` scrapes data → JSON response
3. **Paper Generation**: `/api/generate_paper` → SSE streaming → Word document saved to `user_data/papers/`

### Database Schema (SQLite: `data/urp_helper.db`)

- **users**: `device_id` (PK), `username`, `password`, `bind_time`
- **pending_requests**: Rebinding requests (`request_id`, `device_id`, `old_username`, `new_username`, `reason`, `request_time`, `status`)
- **announcements**: `id`, `title`, `content`, `create_time`, `is_active`
- **user_read_announcements**: `device_id`, `announcement_id`, `read_time`, `never_show`

### Configuration

- **[data/config.json](data/config.json)**: `urp_urls` array with failover, `current_url_index`
- **Admin Key**: Hardcoded in [app.py:154](app.py#L154) as `"786171937Wzs"`
- **API Key**: Set `API_KEY` environment variable or modify [paper_generator.py:12](paper_generator.py#L12)

## API Response Convention

All API endpoints return JSON with this structure:
```python
{'success': bool, 'message': str, 'data': ...}  # or specific fields like 'grades', 'users', etc.
```

## Common Development Patterns

### Adding New URP Data Endpoints

1. Create scraping method in `URP_query` class ([URP.py](URP.py))
2. Add wrapper function in [app.py](app.py) (e.g., `get_grades()`)
3. Create API route with `@require_login` decorator
4. Return: `{'success': bool, 'data': ...}`

### Modifying Paper Templates

Edit `PAPER_TEMPLATES` in [paper_generator.py:24-90](paper_generator.py#L24-L90):
- `ratio`: Word count proportion (sum to ~1.0 excluding abstract/keywords/references)
- `min`: Minimum words per section
- Add corresponding prompt in `section_prompts` dict

### Database Operations

```python
with get_db() as conn:
    conn.execute('ALTER TABLE users ADD COLUMN new_field TEXT')
```

## Implementation Details

### URP System

- VPN cookies fetched via `vpncookie_get()` to bypass network restrictions
- CAPTCHA: ddddocr with up to 3 retries on failure
- Login state: `is_logined()` checks if username appears in `/menu/top.jsp`

### Paper Generation

- Word formatting: Title (二号宋体 22pt), headings (三号黑体 16pt), body (小四宋体 12pt, 1.5 line spacing)
- Citations renumbered globally via `renumber_citations()`
- Uses third-party API at `https://api.coolyeah.net` with model `claude-sonnet-4-5-20250929`

## Known Issues

- **[app.py:320-324](app.py#L320-L324)**: `check_login_status()` doesn't return after deleting expired cookies - function falls through without re-login attempt
- Grade scraping hardcoded for "2025-2026学年秋(两学期)" semester ([URP.py:105](URP.py#L105))
- Schedule, exams, experiments endpoints return mock data (not implemented)
- SSL verification disabled (`verify=False`) - enable for production
- Passwords stored in plaintext in SQLite
- No automated tests
