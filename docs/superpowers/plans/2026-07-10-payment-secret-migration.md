# Payment Secret Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the real payment secret from tracked source while preserving the payment platform's existing signing and callback protocol.

**Architecture:** `constants.py` exposes `get_pay_secret_key()`, which reads `PAY_SECRET_KEY` from the process environment first and then reads the ignored local JSON secret file. Payment routes obtain the secret at request time, preserving the MD5 input while rejecting payment operations when configuration is missing.

**Tech Stack:** Python 3, Flask, standard-library `json` and `unittest`.

## Global Constraints

- Keep the existing merchant number and MD5 input order unchanged.
- Never write a real key into a tracked file.
- The fallback file is `data/payment_secrets.json` with the JSON property `pay_secret_key`.
- Preserve unrelated uncommitted changes in the current workspace.

---

### Task 1: Define and test key-source behavior

**Files:**
- Create: `test/test_payment_secrets.py`
- Modify: `constants.py:14-19`

**Interfaces:**
- Produces: `get_pay_secret_key() -> str | None`.
- Consumes: `PAY_SECRET_KEY` and `data/payment_secrets.json`.

- [ ] **Step 1: Write the failing test**

```python
def test_environment_key_has_priority_over_local_file():
    assert constants.get_pay_secret_key() == 'environment-secret'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python test/test_payment_secrets.py`

Expected: failure because `get_pay_secret_key` is not defined.

- [ ] **Step 3: Write minimal implementation**

```python
def get_pay_secret_key():
    return os.environ.get('PAY_SECRET_KEY') or _load_local_payment_secret()
```

- [ ] **Step 4: Run tests to verify source priority and missing-key behavior**

Run: `python test/test_payment_secrets.py`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add constants.py .gitignore test/test_payment_secrets.py
git commit -m "fix: load payment secret from private config"
```

### Task 2: Keep payment signing compatible and fail closed

**Files:**
- Modify: `routes/member_routes.py:12,79-80,131-133`
- Modify: `test/test_payment_secrets.py`

**Interfaces:**
- Consumes: `get_pay_secret_key() -> str | None`.
- Produces: existing payment API responses without a real key in source.

- [ ] **Step 1: Write failing tests**

```python
def test_payment_routes_do_not_import_a_module_level_secret():
    source = Path('routes/member_routes.py').read_text(encoding='utf-8')
    assert 'PAY_SECRET_KEY,' not in source
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python test/test_payment_secrets.py`

Expected: failure because the route still imports the module-level key.

- [ ] **Step 3: Write minimal implementation**

```python
secret = get_pay_secret_key()
if not secret:
    return jsonify({'success': False, 'message': '支付密钥未配置'}), 503
```

Use `secret` in the existing MD5 input without changing its field order.

- [ ] **Step 4: Run tests and syntax checks**

Run: `python test/test_payment_secrets.py`

Run: `python -c "compile(open('constants.py', encoding='utf-8').read(), 'constants.py', 'exec'); compile(open('routes/member_routes.py', encoding='utf-8').read(), 'routes/member_routes.py', 'exec'); print('syntax OK')"`

Expected: all tests pass and output is `syntax OK`.

- [ ] **Step 5: Commit**

```bash
git add routes/member_routes.py test/test_payment_secrets.py
git commit -m "fix: fail closed when payment secret is missing"
```
