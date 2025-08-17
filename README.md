# TourNest Server — Tourism Management System Backend

This is the backend server for **TourNest**, a full-stack tourism and travel management platform where users can explore and book tour packages, apply to become guides, share stories, and manage roles with secure authentication and payments etc.

---

## 🔗 Live Project

- 🌐 **Website**: [https://tournest-sarfaraz-akram.netlify.app](https://tournest-sarfaraz-akram.netlify.app)
- 🧠 **Frontend Repository**: [GitHub – TourNest Client](https://github.com/SarfarazAkram17/TourNest-Client)
---

## 🧰 Tech Stack

| Tech       | Purpose                               |
| ---------- | ------------------------------------- |
| Node.js    | JavaScript runtime                    |
| Express.js | Routing & middleware server           |
| MongoDB    | NoSQL cloud database (Atlas)          |
| Stripe     | Secure online payments (BDT currency) |
| JWT        | Custom role-based token system        |
| dotenv     | Secure environment variable handling  |
| cors       | Enable cross-origin requests          |

---

## 🔐 Authentication & Security

- **Firebase Authentication**: Google and email/password
- **JWT**: Tokens issued on login, register ,google login and validated for all protected routes
- **Role Verification**:
  - `verifyJwt`: Validates token and attaches user
  - `verifyAdmin`: Protects admin-only routes
  - `verifyTourist`: Secures tourist-only actions
  - `verifyTourGuide`: Guards tour guide functionalities

---

## 📦 API Endpoints

### 👥 Users

| Method  | Endpoint                | Middleware                     | Description                          |
| ------- | ----------------------- | ------------------------------ | ------------------------------------ |
| `GET`   | `/users`                | `verifyJwt`, `verifyAdmin`     | Get all users with search/pagination |
| `GET`   | `/users/:email/role`    | -                              | Get role of a specific user          |
| `GET`   | `/users/tour-guide`     | -                              | Get all tour guides                  |
| `GET`   | `/users/tour-guide/:id` | -                              | Get single guide details by ID       |
| `GET`   | `/users/guide-info`     | `verifyJwt`                    | Get logged-in guide’s info           |
| `GET`   | `/random-tour-guides`   | -                              | Get 6 random guides                  |
| `POST`  | `/users`                | -                              | Register or update last login        |
| `PATCH` | `/users/guide-info`     | `verifyJwt`, `verifyTourGuide` | Update guide’s info fields           |

---

### 🔐 JWT

| Method | Endpoint | Middleware | Description                  |
| ------ | -------- | ---------- | ---------------------------- |
| `POST` | `/jwt`   | -          | Issue JWT for logged-in user |

---

### 🌍 Tour Packages

| Method | Endpoint           | Middleware                 | Description                  |
| ------ | ------------------ | -------------------------- | ---------------------------- |
| `GET`  | `/packages`        | -                          | Get all packages (paginated) |
| `GET`  | `/packages/:id`    | -                          | Get single package by ID     |
| `GET`  | `/random-packages` | -                          | Get 3 random packages        |
| `POST` | `/packages`        | `verifyJwt`, `verifyAdmin` | Create new package           |

---

### 🧑‍🏫 Tour Guide Applications

| Method   | Endpoint            | Middleware                   | Description                            |
| -------- | ------------------- | ---------------------------- | -------------------------------------- |
| `GET`    | `/applications`     | `verifyJwt`, `verifyAdmin`   | Get all applications (paginated)       |
| `POST`   | `/applications`     | `verifyJwt`, `verifyTourist` | Apply to become a tour guide           |
| `PATCH`  | `/applications`     | `verifyJwt`, `verifyAdmin`   | Approve and promote user to tour guide |
| `DELETE` | `/applications/:id` | `verifyJwt`, `verifyAdmin`   | Delete an application                  |

---

### 📅 Bookings

| Method  | Endpoint                       | Middleware                     | Description                                   |
| ------- | ------------------------------ | ------------------------------ | --------------------------------------------- |
| `GET`   | `/bookings`                    | `verifyJwt`                    | Get bookings by tourist email                 |
| `GET`   | `/bookings/:id`                | `verifyJwt`                    | Get single booking details                    |
| `GET`   | `/bookings/tourGuide/assigned` | `verifyJwt`, `verifyTourGuide` | Get guide’s assigned bookings                 |
| `POST`  | `/bookings`                    | `verifyJwt`                    | Create new booking (prevent duplicate unpaid) |
| `PATCH` | `/bookings/:id`                | `verifyJwt`                    | Update booking status (accepted/rejected)     |

---

### 💳 Payments

| Method | Endpoint                 | Middleware  | Description                           |
| ------ | ------------------------ | ----------- | ------------------------------------- |
| `POST` | `/create-payment-intent` | `verifyJwt` | Create Stripe intent for card payment |
| `POST` | `/payments`              | `verifyJwt` | Save payment record & update booking  |

---

### 📖 Stories

| Method   | Endpoint          | Middleware  | Description                             |
| -------- | ----------------- | ----------- | --------------------------------------- |
| `GET`    | `/stories`        | -           | Get stories by email or all (paginated) |
| `GET`    | `/stories/:id`    | -           | Get story by ID                         |
| `GET`    | `/random-stories` | -           | Get 4 random stories                    |
| `POST`   | `/stories`        | `verifyJwt` | Add new story                           |
| `PATCH`  | `/stories/:id`    | `verifyJwt` | Update title, description, and images   |
| `DELETE` | `/stories/:id`    | `verifyJwt` | Delete story by ID                      |

---

### 📊 Stats

| Method | Endpoint       | Middleware                 | Description                                              |
| ------ | -------------- | -------------------------- | -------------------------------------------------------- |
| `GET`  | `/admin/stats` | `verifyJwt`, `verifyAdmin` | Get totals: payments, guides, clients, stories, packages. Payment trends |

---

# 🛠️ Getting Started

git clone https://github.com/SarfarazAkram17/TourNest-Server <br />
cd TourNest-Server