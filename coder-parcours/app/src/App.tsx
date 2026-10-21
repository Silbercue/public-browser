import { Route, Routes } from 'react-router';
import Layout from './components/Layout';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import Bookings from './pages/Bookings';

/** Placeholder until the booking pages exist (heading plus station section). */
function Placeholder({ title, section }: { title: string; section?: string }) {
  return (
    <section className="page" data-section={section}>
      <h1>{title}</h1>
      <p className="muted">This page is being set up.</p>
    </section>
  );
}

function NotFound() {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <p>We could not find this page.</p>
    </section>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="schedule" element={<Placeholder title="Schedule" section="schedule" />} />
        <Route path="classes/:id" element={<Placeholder title="Class" section="class-detail" />} />
        <Route path="cart" element={<Placeholder title="Your cart" section="cart" />} />
        <Route path="checkout" element={<Placeholder title="Checkout" section="checkout" />} />
        <Route path="confirmation/:reference" element={<Placeholder title="Booking confirmed" />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
