# Investment Tracker

A full-stack application to track Equity and Mutual Fund investments. Uses an Angular frontend with a Python Flask backend, storing data in an Excel file (`Investment Listing.xlsx`).

## Project Structure

```
Investments/
├── Investment Listing.xlsx    ← Persistent data store (Excel)
├── backend/
│   ├── app.py                 ← Flask API server
│   ├── excel_service.py       ← Excel read/write logic
│   └── requirements.txt       ← Python dependencies
└── frontend/                  ← Angular 19 app
    └── src/app/
        ├── components/
        │   ├── dashboard/     ← Summary dashboard
        │   ├── equity/        ← Equity CRUD
        │   └── mutual-funds/  ← Mutual Funds CRUD
        ├── models/            ← TypeScript interfaces
        └── services/          ← API service
```

## Setup & Run

### Backend (Python Flask)

```bash
cd backend
pip install -r requirements.txt
python app.py
```

The API will run at **http://localhost:5000**.

### Frontend (Angular)

```bash
cd frontend
npm install
ng serve
```

The UI will run at **http://localhost:4200**.

## API Endpoints

| Method | Endpoint                    | Description              |
|--------|-----------------------------|--------------------------|
| GET    | `/api/equity`               | List all equity entries  |
| POST   | `/api/equity`               | Add equity entry         |
| PUT    | `/api/equity/<id>`          | Update equity entry      |
| DELETE | `/api/equity/<id>`          | Delete equity entry      |
| GET    | `/api/mutual-funds`         | List all MF entries      |
| POST   | `/api/mutual-funds`         | Add MF entry             |
| PUT    | `/api/mutual-funds/<id>`    | Update MF entry          |
| DELETE | `/api/mutual-funds/<id>`    | Delete MF entry          |
| GET    | `/api/summary`              | Portfolio summary        |

## Excel File

The app reads from and writes to `Investment Listing.xlsx` with two sheets:

- **Equity**: Market Cap, Sector, Name, Date, Buy Value, Sell Value, Buy / Sell, Remarks
- **Mutual Funds**: Category, Fund Type, Name, Date, Buy Value, Sell Value, Buy / Sell, Remarks
