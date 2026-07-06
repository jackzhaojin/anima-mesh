# Quick Reference Card - Claude Agent SDK OAuth

## 🚀 Quick Setup (3 Steps)

```bash
# 1. Get OAuth token
claude setup-token

# 2. Add to .env file
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-your-token-here

# 3. Run the demo
npm run dev
```

---

## ⚠️ Critical Requirements

| Requirement | Must Have |
|-------------|-----------|
| **Token Format** | Starts with `sk-ant-` |
| **Expiration** | 1 year from generation |
| **Node.js** | Version 18+ |
| **Subscription** | Claude Pro or Max |
| **No Quotes** | Token should NOT be in quotes in .env |

---

## 🔑 Token Checklist

Before asking "why doesn't it work?", verify:

- [ ] Token starts with `sk-ant-`
- [ ] Token copied completely (very long!)
- [ ] No extra spaces or line breaks
- [ ] Not wrapped in quotes in `.env`
- [ ] `.env` file exists in project root
- [ ] Token not expired (< 1 year old)

---

## 🐛 Common Errors & Fixes

### ❌ "Invalid bearer token"
```bash
# Fix: Regenerate token
claude setup-token
# Update .env with new token
```

### ❌ "No authentication credentials found"
```bash
# Fix: Check .env file exists and has token
cat .env | grep CLAUDE_CODE_OAUTH_TOKEN
```

### ❌ "command not found: claude"
```bash
# Fix: Install Claude CLI
npm install -g @anthropic-ai/claude-code
```

### ❌ Node version error
```bash
# Fix: Use Node 18+
nvm install 20
nvm use 20
```

---

## 📝 .env File Template

```env
# OAuth Token (required) - starts with sk-ant-
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-api03-your-actual-token-here

# Model (optional) - defaults to claude-sonnet-4-5
MODEL=claude-sonnet-4-5
```

---

## 🎯 Commands

| Task | Command |
|------|---------|
| **Get token** | `claude setup-token` |
| **Install deps** | `npm install` |
| **Run dev mode** | `npm run dev` |
| **Build** | `npm run build` |
| **Run production** | `npm start` |
| **Clean build** | `npm run clean` |

---

## 💰 Cost & Billing

- ✅ Uses Claude Pro/Max subscription
- ✅ Fixed monthly cost
- ✅ No pay-per-use charges
- ⏰ Token expires in 1 year

---

## 🆘 Need Help?

1. Check [SETUP-GUIDE.md](./SETUP-GUIDE.md) - Comprehensive guide
2. Verify token: `echo $CLAUDE_CODE_OAUTH_TOKEN`
3. Regenerate token: `claude setup-token`
4. Check Node version: `node --version`

---

## 📅 Important Reminders

Set a calendar reminder for **11 months from now** to regenerate your OAuth token before it expires!

---

## ✅ Success Test

```bash
# Should show OAuth Token authentication
npm run dev

# Expected output:
# 🤖 Claude Agent SDK Chat Demo
# Auth: OAuth Token ✅
```

---

**Last Updated:** December 11, 2024
