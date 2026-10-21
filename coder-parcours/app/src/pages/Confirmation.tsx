import { Link, useParams } from 'react-router';
import './booking.css';

export default function Confirmation() {
  const { reference = '' } = useParams();
  return (
    <section className="page narrow">
      <div className="card confirmation">
        <h1>Booking confirmed</h1>
        <p>Thank you. Your spots are reserved, see you on the mat.</p>
        <p>Your reference: <strong data-testid="reference">{reference}</strong></p>
        <Link to="/bookings" className="button primary">See my bookings</Link>
      </div>
    </section>
  );
}
