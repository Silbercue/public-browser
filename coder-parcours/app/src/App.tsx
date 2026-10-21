import { Route, Routes, useSearchParams } from 'react-router';
import Layout from './components/Layout';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import Bookings from './pages/Bookings';
import Schedule from './pages/Schedule';
import ClassDetail from './pages/ClassDetail';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import Confirmation from './pages/Confirmation';

/** Login page; guests sent here from the checkout also see why. */
function LoginPage() {
  const [params] = useSearchParams();
  return (
    <>
      {params.get('next') === '/checkout' && <p className="notice notice-warning page narrow" role="status">Please log in to book.</p>}
      <Login />
    </>
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
        <Route path="schedule" element={<Schedule />} />
        <Route path="classes/:id" element={<ClassDetail />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="confirmation/:reference" element={<Confirmation />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<Register />} />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
