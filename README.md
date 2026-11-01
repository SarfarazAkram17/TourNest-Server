# TourNest Server — Tourism Management System Backend

The REST API behind **TourNest**: tour packages, guide applications, bookings with a guarded status workflow, Stripe payments with automatic refunds, stories and role-specific dashboard statistics.

---

## 🔗 Live Project

- 🌐 **Website**: [https://tournest-sarfaraz-akram.netlify.app](https://tournest-sarfaraz-akram.netlify.app)
- 🧠 **Frontend Repository**: [GitHub – TourNest Client](https://github.com/SarfarazAkram17/TourNest-Client)

---

## ✨ What's New in This Version

- **Verified sign-in**: `/users` and `/jwt` accept a Firebase ID token (set `FIREBASE_PROJECT_ID`). New users are always created as `tourist`; a client can no longer choose its own role.
- **Live roles**: the role is re-read from the database on every protected call, so promotions apply immediately (no re-login). Expired tokens return `401`.
- **Booking state machine** with ownership checks, double-booking protection for guides and **automatic Stripe refunds** when a paid booking is cancelled or declined.
- **Server-trusted payments**: the amount comes from the booking, and `/payments` verifies the PaymentIntent with Stripe before recording it.
- **Server-side search, filters and sorting** for packages, stories, bookings, users and applications (regex input is escaped).
- **Richer dashboard stats** for all three roles, plus a public stats endpoint for the home page.
- **Guide application tracking** (`/applications/mine`) and one-step approval (`PATCH /applications`).

---

## 🧰 Tech Stack

| Tech | Purpose |
| --- | --- |
| Node.js | JavaScript runtime |
| Express 5 | Routing and middleware |
| MongoDB (Atlas) | Database |
| Stripe | Card payments (BDT) and refunds |
| JWT | Role-based access tokens (1 day) |
| Firebase ID tokens | Proof of identity at sign-in |
| dotenv, cors | Configuration and cross-origin requests |

---

## 🔐 Authentication & Security

1. The client signs in with Firebase and sends its **ID token** (`Authorization: Bearer <idToken>`) to `POST /users` and `POST /jwt`.
2. The server verifies the token against Google's public keys (when `FIREBASE_PROJECT_ID` is set) and issues a **TourNest JWT**.
3. Protected routes require `Authorization: Bearer <jwt>` and `?email=<your email>` matching the token.

| Middleware | Purpose |
| --- | --- |
| `identify` | Verifies the Firebase ID token for `/users` and `/jwt` |
| `verifyJwt` | Validates the JWT, matches the email and loads the **current** role from the database |
| `verifyAdmin` / `verifyTourist` / `verifyTourGuide` | Role guards |

> ⚠️ If `FIREBASE_PROJECT_ID` is **not** set the API logs a warning and falls back to trusting the email in the request body. That is only acceptable for local development. Always set it in production.

---

## 🔄 Booking Workflow

```
POST /bookings            -> status: pending,   payment_status: not_paid
POST /create-payment-intent + Stripe confirm
POST /payments            -> status: in review, payment_status: paid
PATCH /bookings/:id       -> accepted | rejected | cancelled
```

| Action | Who | Allowed from | Result |
| --- | --- | --- | --- |
| `cancelled` | the tourist who booked | `pending`, `in review` | refunded automatically if paid |
| `accepted` | the assigned guide | `in review` | confirmed |
| `rejected` | the assigned guide | `pending`, `in review` | refunded automatically if paid |

- `payment_status` is `not_paid`, `paid` or `refunded`.
- A "completed" tour is derived: `accepted` and the tour dates have passed.
- A failed Stripe refund leaves the booking unchanged and returns `502`.
- Booking validations: future date, guide exists and is not yourself, no unpaid duplicate for the same trip, guide not already booked that day. **Only tourist accounts can book** (guides and admins get `403`).

---

## 📦 API Endpoints

`Auth` below means `verifyJwt` plus `?email=<your email>`.

> Every protected route checks the caller's **current** role in the database, so a client can't reach another role's endpoints even with a valid token.

### 🔐 Session & Users

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/jwt` | Firebase ID token | Issue a TourNest JWT |
| `POST` | `/users` | Firebase ID token | Create the user (role `tourist`) or update last login |
| `GET` | `/users` | Admin | Users with `search`, `searchType`, `role`, `page`, `limit`; returns `users`, `total`, `counts` |
| `GET` | `/users/:email/role` | Public | Role of a user |
| `GET` | `/users/tour-guide` | Public | All tour guides |
| `GET` | `/users/tour-guide/:id` | Public | One guide |
| `GET` | `/random-tour-guides` | Public | 6 random guides |
| `GET` | `/users/guide-info` | Tour guide | Logged-in guide's profile |
| `PATCH` | `/users/guide-info` | Tour guide | Update guide profile (validated fields) |

### 🌍 Tour Packages

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/packages` | Public | Paginated (12). Query: `page`, `search`, `type` (case-insensitive), `sort` (`newest`, `price-asc`, `price-desc`) |
| `GET` | `/packages/types` | Public | Trip types taken from all packages in the database (case-insensitive, de-duplicated) |
| `GET` | `/packages/:id` | Public | One package |
| `GET` | `/random-packages` | Public | 3 random packages |
| `POST` | `/packages` | Admin | Create a package (validated) |
| `PATCH` | `/packages/:id` | Admin | Update a package. Existing bookings keep the price and title they were made with |
| `DELETE` | `/packages/:id` | Admin | Delete a package. Blocked (`409`) while it has unfinished bookings |

### 🧑‍🏫 Guide Applications

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/applications` | Admin | Paginated; `status`, `search`, `region` |
| `GET` | `/applications/mine` | Tourist | The caller's own application (`{ application }` or `null`) |
| `POST` | `/applications` | Tourist | Apply (validated, one per user) |
| `PATCH` | `/applications` | Admin | Body `{ applicationId }`: promote the applicant to tour guide and remove the application |
| `DELETE` | `/applications/:id` | Admin | Decline an application |

### 📅 Bookings

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/bookings` | Tourist | Caller's bookings. Query: `page`, `limit`, `search`, `status` (`all`, `unpaid`, `in review`, `accepted`, `rejected`, `cancelled`); returns `bookings`, `total`, `paidTotal` |
| `GET` | `/bookings/:id` | Tourist (owner) | One booking |
| `GET` | `/bookings/tourGuide/assigned` | Tour guide | Guide's bookings (`status`, `search`, `page`, `limit`) |
| `POST` | `/bookings` | Tourist | Body `{ packageId, tourDate, tourDay, tourGuideEmail }`; price, names and images come from the database |
| `PATCH` | `/bookings/:id` | Tourist (owner) or assigned tour guide; admins get `403` | Body `{ status }`, see the workflow table |

### 💳 Payments

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/create-payment-intent` | Tourist | Body `{ bookingId }`; amount is taken from the booking |
| `POST` | `/payments` | Tourist | Body `{ bookingId, transactionId }`; verifies the intent with Stripe, records the payment, moves the booking to `in review` |

### 📖 Stories

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/stories` | Public | Paginated (12). Query: `page`, `email`, `search` |
| `GET` | `/stories/:id` | Public | One story |
| `GET` | `/random-stories` | Public | 3 random stories |
| `POST` | `/stories` | Auth | Create a story (author details come from the account) |
| `PATCH` | `/stories/:id` | Owner | Update title, text, location and images |
| `DELETE` | `/stories/:id` | Owner or admin | Delete a story |

### 📊 Stats

| Method | Endpoint | Access | Highlights |
| --- | --- | --- | --- |
| `GET` | `/stats/public` | Public | `tourists`, `guides`, `packages`, `stories` for the home page |
| `GET` | `/admin/stats` | Admin | Revenue (net of refunds) and trend, totals, `pendingApplications`, `bookingStatus`, `recentBookings`, `recentUsers`, `topPackages` |
| `GET` | `/tourist/stats` | Tourist | KPIs, `monthlySpending`, `spentPerPackage`, `tourDistribution`, `nextTrips`, `awaitingPayment`, `recentBookings` |
| `GET` | `/tourGuide/stats` | Tour guide | KPIs incl. `awaitingResponse` and `earnings`, `monthlyTours`, `toursPerPackage`, `tourDistribution`, `requests`, `nextTours` |

---

## 🛠️ Getting Started

```bash
git clone https://github.com/SarfarazAkram17/TourNest-Server
cd TourNest-Server
npm install
cp .env.example .env   # then fill in your values
npm start              # http://localhost:3000
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB_USER`, `DB_PASS` | ✅ | MongoDB Atlas credentials |
| `JWT_SECRET` | ✅ | Secret used to sign access tokens |
| `PAYMENT_GATEWAY_KEY` | ✅ | Stripe **secret** key |
| `FIREBASE_PROJECT_ID` | Strongly recommended | Enables Firebase ID-token verification |
| `PORT` | Optional | Defaults to `3000` |

Deployed on Vercel (see `vercel.json`). Keep `.env` out of version control and rotate any secret that was ever shared.
